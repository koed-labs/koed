"""Private, bounded tensor IPC. No network, downloads, logging or credentials."""
import json
import os
import platform
import struct
import sys

import numpy as np
import onnxruntime as ort

ort.disable_telemetry_events()

PROTOCOL = 2
MAX_INPUT = 65536
MAX_OUTPUT = 2 * 1024 * 1024
LABELS = 33


def read_exact(size):
    data = bytearray()
    while len(data) < size:
        chunk = sys.stdin.buffer.read(size - len(data))
        if not chunk:
            raise EOFError()
        data.extend(chunk)
    return bytes(data)


def send(frame):
    data = json.dumps(frame, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if not 0 < len(data) <= MAX_OUTPUT:
        raise ValueError()
    sys.stdout.buffer.write(struct.pack(">I", len(data)) + data)
    sys.stdout.buffer.flush()


def main():
    model_path, generation, threads = sys.argv[1:]
    if threads not in ("1", "2", "4"):
        raise ValueError()
    options = ort.SessionOptions()
    options.intra_op_num_threads = int(threads)
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.log_severity_level = 4
    session = ort.InferenceSession(
        os.path.join(model_path, "onnx/model_q4.onnx"),
        sess_options=options, providers=["CPUExecutionProvider"]
    )
    session.disable_fallback()
    if session.get_providers() != ["CPUExecutionProvider"]:
        raise ValueError()
    send(dict(protocol=PROTOCOL, generation=generation, job="ready",
              engine=ort.__version__, numpy=np.__version__, python=platform.python_version()))
    while True:
        size = struct.unpack(">I", read_exact(4))[0]
        if not 0 < size <= MAX_INPUT:
            raise ValueError()
        frame = json.loads(read_exact(size))
        if (set(frame) not in ({"protocol", "generation", "job", "tokenIds"}, {"protocol", "generation", "job", "rows"})
                or frame["protocol"] != PROTOCOL or frame["generation"] != generation
                or not isinstance(frame["job"], str) or len(frame["job"]) != 36):
            raise ValueError()
        if "rows" in frame:
            rows = frame["rows"]
            if not isinstance(rows, list) or not 1 <= len(rows) <= 8:
                raise ValueError()
            ids_seen = set()
            for row in rows:
                if (not isinstance(row, dict) or set(row) != {"id", "tokenIds"}
                        or not isinstance(row["id"], str) or len(row["id"]) != 36
                        or row["id"] in ids_seen or not isinstance(row["tokenIds"], list)
                        or not 1 <= len(row["tokenIds"]) <= 256
                        or any(type(value) is not int or not 0 <= value <= 2**53 - 1 for value in row["tokenIds"])):
                    raise ValueError()
                ids_seen.add(row["id"])
            length = max(len(row["tokenIds"]) for row in rows)
            if length * len(rows) > 2048:
                raise ValueError()
            tensor = np.zeros((len(rows), length), dtype=np.int64)
            attention = np.zeros_like(tensor)
            for index, row in enumerate(rows):
                size = len(row["tokenIds"])
                tensor[index, :size] = row["tokenIds"]
                attention[index, :size] = 1
            logits = session.run(["logits"], dict(input_ids=tensor, attention_mask=attention))[0]
            if logits.shape != (len(rows), length, LABELS) or not np.isfinite(logits).all():
                raise ValueError()
            output = [dict(id=row["id"], tokenLength=len(row["tokenIds"]), logits=logits[index].tolist())
                      for index, row in enumerate(rows)]
            send(dict(protocol=PROTOCOL, generation=generation, job=frame["job"], paddedTokens=length, rows=output))
            continue
        ids = frame["tokenIds"]
        if (not isinstance(ids, list) or not 0 < len(ids) <= 512
                or any(type(value) is not int or not 0 <= value <= 2**53 - 1 for value in ids)):
            raise ValueError()
        tensor = np.asarray([ids], dtype=np.int64)
        logits = session.run(["logits"], dict(input_ids=tensor, attention_mask=np.ones_like(tensor)))[0]
        if logits.shape != (1, len(ids), LABELS) or not np.isfinite(logits).all():
            raise ValueError()
        send(dict(protocol=PROTOCOL, generation=generation, job=frame["job"], logits=logits[0].tolist()))


if __name__ == "__main__":
    try:
        main()
    except EOFError:
        pass
    except BaseException:
        # Never emit native exception text or a possibly sensitive frame.
        sys.exit(1)
