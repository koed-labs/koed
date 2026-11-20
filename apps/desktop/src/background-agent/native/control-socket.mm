#include "control-socket.h"

#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

namespace koed {
namespace {
bool socketAddress(const std::string &path, sockaddr_un *address) {
  if (path.empty() || path[0] != '/' || path.size() >= sizeof(address->sun_path) ||
      path.find('\0') != std::string::npos) {
    errno = EINVAL;
    return false;
  }
  std::memset(address, 0, sizeof(*address));
  address->sun_family = AF_UNIX;
  address->sun_len = sizeof(*address);
  std::memcpy(address->sun_path, path.c_str(), path.size() + 1);
  return true;
}

bool configureSocket(int fd) {
  const int flags = fcntl(fd, F_GETFL);
  const int fdFlags = fcntl(fd, F_GETFD);
  const int noSigPipe = 1;
  return flags >= 0 && fdFlags >= 0 &&
         fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 &&
         fcntl(fd, F_SETFD, fdFlags | FD_CLOEXEC) == 0 &&
         setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, sizeof(noSigPipe)) == 0;
}

int createSocket() {
  const int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  if (!configureSocket(fd)) { const int error = errno; close(fd); errno = error; return -1; }
  return fd;
}
}

bool openControlListener(const std::string &path, ControlListener *listener) {
  if (!listener || listener->fd != -1) { errno = EINVAL; return false; }
  sockaddr_un address{};
  if (!socketAddress(path, &address)) return false;
  const int fd = createSocket();
  if (fd < 0) return false;
  if (bind(fd, reinterpret_cast<sockaddr *>(&address), sizeof(address)) != 0) {
    const int error = errno; close(fd); errno = error; return false;
  }
  struct stat info{};
  if (lstat(path.c_str(), &info) != 0) {
    // Ownership is unknown: leave the pathname for explicit inspection.
    const int error = errno; close(fd); errno = error; return false;
  }
  if (!S_ISSOCK(info.st_mode) || info.st_uid != geteuid()) {
    close(fd); errno = EACCES; return false;
  }
  listener->fd = fd;
  listener->path = path;
  listener->device = info.st_dev;
  listener->inode = info.st_ino;
  if (fchmodat(AT_FDCWD, path.c_str(), 0600, AT_SYMLINK_NOFOLLOW) != 0) {
    const int error = errno; closeControlListener(listener); errno = error; return false;
  }
  struct stat after{};
  if (lstat(path.c_str(), &after) != 0) {
    const int error = errno; closeControlListener(listener); errno = error; return false;
  }
  if (!S_ISSOCK(after.st_mode) || after.st_dev != info.st_dev || after.st_ino != info.st_ino ||
      after.st_uid != geteuid() || (after.st_mode & 0777) != 0600) {
    closeControlListener(listener); errno = EACCES; return false;
  }
  if (listen(fd, 16) != 0) {
    const int error = errno; closeControlListener(listener); errno = error; return false;
  }
  return true;
}

void closeControlListener(ControlListener *listener) {
  if (!listener || listener->fd < 0) return;
  close(listener->fd);
  listener->fd = -1;
  struct stat info{};
  if (lstat(listener->path.c_str(), &info) == 0 && S_ISSOCK(info.st_mode) &&
      info.st_dev == listener->device && info.st_ino == listener->inode)
    unlink(listener->path.c_str());
}

int connectControlSocket(const std::string &path) {
  sockaddr_un address{};
  if (!socketAddress(path, &address)) return -1;
  const int fd = createSocket();
  if (fd < 0) return -1;
  if (connect(fd, reinterpret_cast<sockaddr *>(&address), sizeof(address)) != 0 && errno != EINPROGRESS) {
    const int error = errno; close(fd); errno = error; return -1;
  }
  return fd;
}

bool authenticateConnectedControlSocket(int fd, SecRequirementRef requirement, ControlPeer *peer) {
  int error = 0;
  socklen_t length = sizeof(error);
  if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) != 0 || error != 0) {
    if (error) errno = error;
    return false;
  }
  return verifyControlPeer(fd, requirement, peer);
}

int acceptControlSocket(int listener, SecRequirementRef requirement, ControlPeer *peer) {
  const int fd = accept(listener, nullptr, nullptr);
  if (fd < 0) return -1;
  if (!configureSocket(fd)) {
    const int error = errno; close(fd); errno = error; return -1;
  }
  if (!verifyControlPeer(fd, requirement, peer)) {
    close(fd); errno = EACCES; return -1;
  }
  return fd;
}
}
