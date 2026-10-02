#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static int file_exists(const char *path)
{
    return path != NULL && access(path, F_OK) == 0;
}

static pid_t configured_target(const char *path)
{
    char buffer[32];
    char *end;
    int descriptor;
    long value;
    ssize_t length;

    if (path == NULL)
    {
        return 0;
    }

    descriptor = open(path, O_RDONLY | O_CLOEXEC);
    if (descriptor < 0)
    {
        return 0;
    }

    length = read(descriptor, buffer, sizeof(buffer) - 1);
    close(descriptor);
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

static void record_reap(const char *path, pid_t target)
{
    int descriptor;
    char buffer[96];
    int length;

    if (path == NULL)
    {
        return;
    }

    descriptor = open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
    if (descriptor < 0)
    {
        return;
    }

    length = snprintf(
        buffer,
        sizeof(buffer),
        "reaped pid1 child target=%ld init=%ld\n",
        (long) target,
        (long) getpid()
    );
    if (length > 0)
    {
        ssize_t written = write(descriptor, buffer, (size_t) length);
        (void) written;
    }
    close(descriptor);
}

int main(int argc, char **argv)
{
    const char *audit_path = getenv("ALE44_PID1_ZOMBIE_AUDIT_FILE");
    const char *release_path = getenv("ALE44_PID1_ZOMBIE_RELEASE_FILE");
    const char *target_path = getenv("ALE44_PID1_ZOMBIE_TARGET_FILE");
    int child_status = 0;
    int target_status = 0;
    int target_reaped = 0;
    pid_t child;

    if (getpid() != 1 || argc < 2 || audit_path == NULL || release_path == NULL || target_path == NULL)
    {
        fprintf(stderr, "PPID-1 zombie init requires PID 1, a child command, and private control paths\n");
        return 125;
    }

    child = fork();
    if (child < 0)
    {
        perror("fork");
        return 125;
    }
    if (child == 0)
    {
        execvp(argv[1], &argv[1]);
        perror("execvp");
        _exit(127);
    }

    for (;;)
    {
        pid_t target = configured_target(target_path);
        pid_t child_result;

        if (!target_reaped && target > 0 && file_exists(release_path))
        {
            pid_t target_result;
            do
            {
                target_result = waitpid(target, &target_status, 0);
            }
            while (target_result < 0 && errno == EINTR);

            if (target_result == target)
            {
                target_reaped = 1;
                record_reap(audit_path, target);
            }
            else if (target_result < 0 && errno != ECHILD)
            {
                perror("waitpid target");
                kill(child, SIGKILL);
                return 125;
            }
        }

        child_result = waitpid(child, &child_status, WNOHANG);
        if (child_result == child)
        {
            if (!target_reaped && configured_target(target_path) > 0)
            {
                fprintf(stderr, "Scenario exited before PID 1 reaped the configured target\n");
                return 125;
            }
            return WIFEXITED(child_status) ? WEXITSTATUS(child_status) : 128 + WTERMSIG(child_status);
        }
        if (child_result < 0 && errno != EINTR)
        {
            perror("waitpid scenario");
            return 125;
        }

        usleep(5000);
    }
}
