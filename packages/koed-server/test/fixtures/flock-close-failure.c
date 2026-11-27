#include <node_api.h>
#include <unistd.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>

static int injected_close(int fd) {
  const char *inject = getenv("KOED_TEST_FLOCK_CLOSE_FAILURE");
  if (inject) {
    if (!strcmp(inject, "closed")) close(fd);
    errno = EIO;
    return -1;
  }
  return close(fd);
}

static void *injected_malloc(size_t size) {
  static int count;
  const char *inject = getenv("KOED_TEST_FLOCK_FAILURE");
  if (inject && !strcmp(inject, "malloc") && ++count == 3) return NULL;
  return malloc(size);
}

static napi_status injected_create_object(napi_env env, napi_value *result) {
  const char *inject = getenv("KOED_TEST_FLOCK_FAILURE");
  if (inject && !strcmp(inject, "napi")) return napi_generic_failure;
  return napi_create_object(env, result);
}

static int injected_fstat(int fd, struct stat *st) {
  const char *inject = getenv("KOED_TEST_FLOCK_FAILURE");
  if (inject && !strcmp(inject, "fstat")) { errno = EBADF; return -1; }
  return fstat(fd, st);
}

static int injected_flock(int fd, int operation) {
  const char *inject = getenv("KOED_TEST_FLOCK_FAILURE");
  if (inject && !strcmp(inject, "flock")) { errno = ENOLCK; return -1; }
  return flock(fd, operation);
}

#define close injected_close
#define malloc injected_malloc
#define napi_create_object injected_create_object
#define fstat injected_fstat
#define flock injected_flock
#include "../../native/flock.c"
