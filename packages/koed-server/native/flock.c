#if defined(KOED_FLOCK_UNSUPPORTED_PLATFORM) || (!defined(__linux__) && !defined(__APPLE__))
#error "Native flock supports Linux and macOS only"
#endif
#include <node_api.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { int fd; int close_error; } lock_handle;
static const napi_type_tag lock_tag = {0x583ed589024c4edbULL, 0x9d3d1b337065f863ULL};

static napi_value failure(napi_env env, const char *message) {
  napi_throw_error(env, NULL, message);
  return NULL;
}

static const char *errno_code(int error) {
  switch (error) {
    case EACCES: return "EACCES";
    case EPERM: return "EPERM";
    case ENOENT: return "ENOENT";
    case ENOTDIR: return "ENOTDIR";
    case ELOOP: return "ELOOP";
    case EISDIR: return "EISDIR";
    case EMFILE: return "EMFILE";
    case ENFILE: return "ENFILE";
    case ENOMEM: return "ENOMEM";
    case ENOSPC: return "ENOSPC";
    case EROFS: return "EROFS";
    case EINTR: return "EINTR";
    case EAGAIN: return "EAGAIN";
    case EIO: return "EIO";
    case EBADF: return "EBADF";
    case EINVAL: return "EINVAL";
    case ENOLCK: return "ENOLCK";
    case ENOSYS: return "ENOSYS";
    case EOPNOTSUPP: return "EOPNOTSUPP";
    default: return "UNKNOWN";
  }
}

static napi_value report_failure(napi_env env, const char *description, const char *operation, int error, int cleanup_error) {
  char message[512];
  if (operation)
    snprintf(message, sizeof(message), "%s: %s", operation, strerror(error));
  else
    snprintf(message, sizeof(message), "%s", description);
  if (cleanup_error) {
    size_t used = strlen(message);
    snprintf(message + used, sizeof(message) - used, "; cleanup close: %s (lock ownership indeterminate)", strerror(cleanup_error));
  } else if (operation && !strcmp(operation, "close")) {
    size_t used = strlen(message);
    snprintf(message + used, sizeof(message) - used, " (lock ownership indeterminate)");
  }
  napi_value text, exception, value;
  if (napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &text) != napi_ok ||
      napi_create_error(env, NULL, text, &exception) != napi_ok)
    return failure(env, "N-API error construction failed");
  if (operation && (napi_create_string_utf8(env, operation, NAPI_AUTO_LENGTH, &value) != napi_ok ||
      napi_set_named_property(env, exception, "operation", value) != napi_ok ||
      napi_create_string_utf8(env, errno_code(error), NAPI_AUTO_LENGTH, &value) != napi_ok ||
      napi_set_named_property(env, exception, "code", value) != napi_ok ||
      napi_create_int32(env, error, &value) != napi_ok ||
      napi_set_named_property(env, exception, "errno", value) != napi_ok))
    return failure(env, "N-API error construction failed");
  if (cleanup_error && (napi_create_string_utf8(env, errno_code(cleanup_error), NAPI_AUTO_LENGTH, &value) != napi_ok ||
      napi_set_named_property(env, exception, "cleanupCode", value) != napi_ok ||
      napi_create_int32(env, cleanup_error, &value) != napi_ok ||
      napi_set_named_property(env, exception, "cleanupErrno", value) != napi_ok))
    return failure(env, "N-API error construction failed");
  if (cleanup_error || (operation && !strcmp(operation, "close"))) {
    if (napi_get_boolean(env, true, &value) != napi_ok ||
        napi_set_named_property(env, exception, "indeterminate", value) != napi_ok)
      return failure(env, "N-API error construction failed");
  }
  napi_throw(env, exception);
  return NULL;
}

static napi_value syscall_failure(napi_env env, const char *operation, int error) {
  return report_failure(env, NULL, operation, error, 0);
}

static napi_value cleanup_failure(napi_env env, int fd, const char *description, const char *operation, int error) {
  int cleanup_error = close(fd) < 0 ? errno : 0;
  if (cleanup_error || operation) return report_failure(env, description, operation, error, cleanup_error);
  return failure(env, description);
}

static void finalize_lock(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  lock_handle *handle = data;
  /* Best effort only: no caller can receive an error, and retry risks closing a reused fd. */
  if (handle->fd >= 0) close(handle->fd);
  free(handle);
}

static napi_value release_lock(napi_env env, napi_callback_info info) {
  napi_value self, result;
  lock_handle *handle = NULL;
  bool tagged = false;
  if (napi_get_cb_info(env, info, NULL, NULL, &self, NULL) != napi_ok ||
      napi_check_object_type_tag(env, self, &lock_tag, &tagged) != napi_ok || !tagged ||
      napi_unwrap(env, self, (void **)&handle) != napi_ok || !handle)
    return failure(env, "Invalid flock handle");
  if (handle->close_error) return syscall_failure(env, "close", handle->close_error);
  int fd = handle->fd;
  handle->fd = -1;
  if (fd >= 0 && close(fd) < 0) {
    handle->close_error = errno;
    return syscall_failure(env, "close", handle->close_error);
  }
  if (napi_get_undefined(env, &result) != napi_ok) return failure(env, "N-API release failed");
  return result;
}

static napi_value wrap_lock(napi_env env, int fd) {
  napi_value object, release;
  lock_handle *handle = malloc(sizeof(*handle));
  if (!handle) return cleanup_failure(env, fd, "Out of memory", NULL, 0);
  handle->fd = fd;
  handle->close_error = 0;
  if (napi_create_object(env, &object) != napi_ok ||
      napi_type_tag_object(env, object, &lock_tag) != napi_ok ||
      napi_create_function(env, "release", NAPI_AUTO_LENGTH, release_lock, NULL, &release) != napi_ok ||
      napi_set_named_property(env, object, "release", release) != napi_ok ||
      napi_wrap(env, object, handle, finalize_lock, NULL, NULL) != napi_ok) {
    free(handle); return cleanup_failure(env, fd, "N-API lock allocation failed", NULL, 0);
  }
  return object;
}

static bool valid_utf16(napi_env env, napi_value value) {
  size_t length, copied;
  if (napi_get_value_string_utf16(env, value, NULL, 0, &length) != napi_ok ||
      length > SIZE_MAX / sizeof(char16_t) - 1) return false;
  char16_t *text = malloc((length + 1) * sizeof(*text));
  if (!text) return false;
  bool valid = napi_get_value_string_utf16(env, value, text, length + 1, &copied) == napi_ok && copied == length;
  for (size_t i = 0; valid && i < length; i++) {
    if (text[i] >= 0xd800 && text[i] <= 0xdbff) {
      if (++i >= length || text[i] < 0xdc00 || text[i] > 0xdfff) valid = false;
    } else if (text[i] >= 0xdc00 && text[i] <= 0xdfff) valid = false;
  }
  free(text);
  return valid;
}

static napi_value acquire(napi_env env, napi_callback_info info) {
  napi_value args[2], result;
  napi_valuetype type;
  size_t argc = 2, length, copied;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 1 ||
      napi_typeof(env, args[0], &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, args[0], NULL, 0, &length) != napi_ok || !length || length == SIZE_MAX)
    return failure(env, "Expected one nonempty absolute path string");
  if (!valid_utf16(env, args[0])) return failure(env, "Invalid UTF-16 path");
  char *path = malloc(length + 1);
  if (!path) return failure(env, "Out of memory");
  if (napi_get_value_string_utf8(env, args[0], path, length + 1, &copied) != napi_ok ||
      copied != length || path[0] != '/' || memchr(path, '\0', length)) {
    free(path); return failure(env, "Invalid absolute path");
  }
  int fd = open(path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0600);
  int error = errno;
  free(path);
  if (fd < 0) return syscall_failure(env, "open", error);
  struct stat st;
  if (fstat(fd, &st) < 0) { error = errno; return cleanup_failure(env, fd, NULL, "fstat", error); }
  if (!S_ISREG(st.st_mode) || st.st_uid != geteuid() || st.st_nlink != 1 || (st.st_mode & 07777 & ~0600)) {
    return cleanup_failure(env, fd, "Unsafe flock file owner, type, links or permissions", NULL, 0);
  }
  if (flock(fd, LOCK_EX | LOCK_NB) < 0) {
    error = errno;
    int cleanup_error = close(fd) < 0 ? errno : 0;
    if (cleanup_error) return report_failure(env, NULL, "flock", error, cleanup_error);
    if (error == EWOULDBLOCK || error == EAGAIN) {
      if (napi_get_null(env, &result) != napi_ok) return failure(env, "N-API null failed");
      return result;
    }
    return syscall_failure(env, "flock", error);
  }
  return wrap_lock(env, fd);
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor property = {"tryAcquire", NULL, acquire, NULL, NULL, NULL, napi_default, NULL};
  if (napi_define_properties(env, exports, 1, &property) != napi_ok) return failure(env, "N-API initialization failed");
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
