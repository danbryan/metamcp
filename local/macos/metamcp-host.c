#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t child_pid = -1;
static volatile sig_atomic_t stopping = 0;

static void forward_signal(int signal_number) {
    stopping = 1;
    pid_t pid = (pid_t)child_pid;
    if (pid > 0) {
        kill(-pid, signal_number);
    }
}

static int install_handler(int signal_number) {
    struct sigaction action;
    action.sa_handler = forward_signal;
    sigemptyset(&action.sa_mask);
    action.sa_flags = SA_RESTART;
    return sigaction(signal_number, &action, NULL);
}

static int run_child(const char *launcher) {
    pid_t pid = fork();
    if (pid < 0) {
        perror("fork");
        return 71;
    }
    if (pid == 0) {
        if (setpgid(0, 0) < 0 && errno != EACCES) {
            perror("setpgid");
            _exit(72);
        }
        execl("/bin/bash", "/bin/bash", launcher, (char *)NULL);
        perror("exec launcher");
        _exit(73);
    }

    child_pid = pid;
    if (setpgid(pid, pid) < 0 && errno != EACCES) {
        perror("setpgid child");
        kill(pid, SIGTERM);
        child_pid = -1;
        return 74;
    }

    int status = 0;
    while (waitpid(pid, &status, 0) < 0) {
        if (errno == EINTR) continue;
        perror("waitpid");
        child_pid = -1;
        return 76;
    }
    child_pid = -1;

    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return 77;
}

int main(void) {
    const char *launcher = getenv("METAMCP_HOST_LAUNCHER");
    if (launcher == NULL || launcher[0] == '\0') {
        launcher = "/Users/danb/Library/Application Support/metamcp/run.sh";
    }

    if (install_handler(SIGTERM) < 0 || install_handler(SIGINT) < 0 ||
        install_handler(SIGHUP) < 0 || install_handler(SIGQUIT) < 0) {
        perror("sigaction");
        return 75;
    }

    while (!stopping) {
        int code = run_child(launcher);
        if (stopping) break;
        fprintf(stderr, "MetaMCP host: launcher exited %d; restarting in 2s\n", code);
        struct timespec delay = {.tv_sec = 2, .tv_nsec = 0};
        while (nanosleep(&delay, &delay) < 0 && errno == EINTR && !stopping) {}
    }
    return 0;
}
