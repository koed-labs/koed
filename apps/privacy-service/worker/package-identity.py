"""Build-time dependency identity, including installed binaries and notices."""
import hashlib
import importlib.metadata
import json
import pathlib
import platform
import sys


def digest(path):
    value = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


packages = []
for name in ("onnxruntime", "numpy", "protobuf", "flatbuffers", "packaging"):
    distribution = importlib.metadata.distribution(name)
    value = hashlib.sha256()
    for entry in sorted(distribution.files, key=str):
        path = pathlib.Path(distribution.locate_file(entry))
        if path.is_file() and path.suffix != ".pyc":
            value.update(str(entry).encode())
            value.update(digest(path).encode())
    packages.append(dict(name=name, version=distribution.version, installedSha256=value.hexdigest()))
print(json.dumps(dict(
    python=platform.python_version(), interpreterSha256=digest(sys.executable),
    pythonBase="sha256:65a93d69fa75478d554f4ad27c85c1e69fa184956261b4301ebaf6dbb0a3543d",
    nodeBase="sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d",
    packages=packages), sort_keys=True))
