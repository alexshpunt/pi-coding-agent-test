#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

typedef pid_t (*waitpid_fn)(pid_t, int *, int);

static waitpid_fn real_waitpid;

static int file_exists(const char *path)
{
    return path != NULL && syscall(SYS_faccessat, AT_FDCWD, path, F_OK, 0) == 0;
}

static pid_t configured_target(void)
{
    const char *path = getenv("ALE44_ZOMBIE_TARGET_FILE");
    char buffer[32];
    long value;
    char *end;
    int descriptor;
    ssize_t length;

    if (path == NULL)
    {
        return 0;
    }

    descriptor = (int) syscall(SYS_openat, AT_FDCWD, path, O_RDONLY | O_CLOEXEC, 0);
    if (descriptor < 0)
    {
        return 0;
    }

    length = syscall(SYS_read, descriptor, buffer, sizeof(buffer) - 1);
    syscall(SYS_close, descriptor);
    if (length <= 0)
    {
        return 0;
    }

    buffer[length] = '\0';
    errno = 0;
    value = strtol(buffer, &end, 10);
    if (errno != 0 || end == buffer || value <= 0)
    {
        return 0;
    }

    return (pid_t) value;
}

static void record_hold(pid_t pid)
{
    const char *path = getenv("ALE44_ZOMBIE_AUDIT_FILE");
    char buffer[64];
    int descriptor;
    int length;

    if (path == NULL)
    {
        return;
    }

    descriptor = (int) syscall(SYS_openat, AT_FDCWD, path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
    if (descriptor < 0)
    {
        return;
    }

    length = snprintf(buffer, sizeof(buffer), "held waitpid for pid=%ld\n", (long) pid);
    if (length > 0)
    {
        syscall(SYS_write, descriptor, buffer, (size_t) length);
    }
    syscall(SYS_close, descriptor);
}

pid_t waitpid(pid_t pid, int *status, int options)
{
    pid_t target;
    const char *release_path;

    if (real_waitpid == NULL)
    {
        real_waitpid = (waitpid_fn) dlsym(RTLD_NEXT, "waitpid");
        if (real_waitpid == NULL)
        {
            errno = ENOSYS;
            return -1;
        }
    }

    target = configured_target();
    release_path = getenv("ALE44_ZOMBIE_RELEASE_FILE");
    if (target > 0 && pid == target && !file_exists(release_path))
    {
        record_hold(pid);
        return 0;
    }

    return real_waitpid(pid, status, options);
}
