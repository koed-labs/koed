#include <sys/types.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <dirent.h>
#include <limits.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#ifdef PROBE_HELPER
int main(int argc, char **argv) {
  struct stat expected, found;
  if (argc != 2 || stat(argv[1], &expected)) return 2;
#ifdef __linux__
  DIR *fds = opendir("/proc/self/fd");
#else
  DIR *fds = opendir("/dev/fd");
#endif
  if (!fds) return 2;
  struct dirent *entry;
  int result = 0;
  while ((entry = readdir(fds))) {
    char *end;
    errno = 0;
    long fd = strtol(entry->d_name, &end, 10);
    if (!errno && *entry->d_name && !*end && fd >= 3 && fd <= INT_MAX &&
        !fstat((int)fd, &found) && found.st_dev == expected.st_dev && found.st_ino == expected.st_ino) {
      result = 1; break;
    }
  }
  closedir(fds);
  return result;
}
#else
#include <node_api.h>
static napi_value probe(napi_env env, napi_callback_info info) {
  napi_value args[4], result; size_t argc = 4, n; char path[4096], helper[4096]; bool control, high = false;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || (argc != 3 && argc != 4) ||
      napi_get_value_string_utf8(env, args[0], path, sizeof(path), &n) != napi_ok ||
      napi_get_value_string_utf8(env, args[1], helper, sizeof(helper), &n) != napi_ok ||
      napi_get_value_bool(env, args[2], &control) != napi_ok ||
      (argc == 4 && napi_get_value_bool(env, args[3], &high) != napi_ok)) { napi_throw_error(env, NULL, "bad arguments"); return NULL; }
  int fd = control ? open(path, O_RDONLY) : -1;
  if (control && fd < 0) { napi_throw_error(env, NULL, "open failed"); return NULL; }
  if (control && high) {
    int high_fd = fcntl(fd, F_DUPFD, 1024);
    close(fd);
    if (high_fd < 0) { napi_throw_error(env, NULL, "high descriptor unavailable"); return NULL; }
    fd = high_fd;
  }
  pid_t pid = fork();
  if (pid == 0) { execl(helper, helper, path, (char *)NULL); _exit(127); }
  int status;
  if (pid < 0 || waitpid(pid, &status, 0) != pid || !WIFEXITED(status)) { if (fd >= 0) close(fd); napi_throw_error(env, NULL, "fork/wait failed"); return NULL; }
  if (fd >= 0) close(fd);
  napi_create_int32(env, WEXITSTATUS(status), &result); return result;
}
static void finalize_foreign(napi_env env, void *data, void *hint) {
  (void)env; (void)hint; free(data);
}
static napi_value foreign(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value object;
  int *value = malloc(sizeof(*value));
  if (!value) { napi_throw_error(env, NULL, "allocation failed"); return NULL; }
  *value = -1;
  if (napi_create_object(env, &object) != napi_ok ||
      napi_wrap(env, object, value, finalize_foreign, NULL, NULL) != napi_ok) {
    free(value); napi_throw_error(env, NULL, "wrap failed"); return NULL;
  }
  return object;
}
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor p[] = {
    {"probe", NULL, probe, NULL, NULL, NULL, napi_default, NULL},
    {"foreign", NULL, foreign, NULL, NULL, NULL, napi_default, NULL}
  };
  napi_define_properties(env, exports, 2, p); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
#endif
