import { fork } from "node:child_process";
import { Server } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { EnrollmentFenceIpcClient } from "./enrollment-fence-ipc-client.js";

const instanceId = "123e4567-e89b-42d3-a456-426614174000";
const epochId = "123e4567e89b42d3a456426614174001-0000000000000001";

function child(script: string, autoFinish = true, autoBind = true) {
  const process = fork(
    "-e",
    [
      (autoBind
        ? `const emit = process.emit; process.emit = function(event, ...args) {
          if (event === 'message') {
            const request = JSON.parse(args[0]);
            if (request.op === 'bind') {
              process.send(JSON.stringify({v:1,type:'response',seq:request.seq,op:'bind',result:{kind:'ok',challenge:'0123456789abcdef0123456789abcdef'}}));
              return true;
            }
            if (request.op === 'bindAck') {
              if (request.args.challenge !== '0123456789abcdef0123456789abcdef') throw new Error('Invalid bind challenge');
              process.send(JSON.stringify({v:1,type:'response',seq:request.seq,op:'bindAck',result:{kind:'ok'}}));
              return true;
            }
          }
          return emit.call(this, event, ...args);
        };
        process.on('message', () => {});\n`
        : "") +
        (autoFinish
          ? script.replaceAll(
              "process.on('message', wire => {",
              `process.on('message', wire => {
    const terminalRequest = JSON.parse(wire);
    if (terminalRequest.op === 'finish') return process.send(JSON.stringify({v:1,type:'response',seq:terminalRequest.seq,op:'finish',result:{kind:'ok'}}), () => process.disconnect());
  `
            )
          : script)
    ],
    {
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    }
  );
  process.on("error", () => {});
  return process;
}

async function stop(process: ReturnType<typeof child>) {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = once(process, "exit");
  process.kill();
  await exited;
}

describe("enrollment fence IPC client", () => {
  it("requires one identity-free bind before operations and poisons on close during bind", async () => {
    const process = child(
      `process.send(JSON.stringify({v:1,type:'ready',instanceId:${JSON.stringify(instanceId)}})); process.on('message', () => {});`,
      false,
      false
    );
    try {
      const client = new EnrollmentFenceIpcClient(process, 1000);
      await client.ready();
      await expect(client.createEpoch()).rejects.toThrow();
      const sent = once(process, "disconnect");
      const binding = client.bind();
      const bindingRejected = expect(binding).rejects.toThrow();
      await expect(client.bind()).rejects.toThrow();
      expect((await client.close(100)).status).toBe("uncertain");
      await bindingRejected;
      await sent;
    } finally {
      await stop(process);
    }
  });
  it("drains tracked epochs over real IPC with the dispatcher", async () => {
    const bundle = await build({
      entryPoints: [
        fileURLToPath(
          new URL(
            "../../shared/src/enrollment-fence-ipc-dispatcher.ts",
            import.meta.url
          )
        )
      ],
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false
    });
    const process = fork(
      "-e",
      [
        `
      new Function('module', 'exports', 'require', ${JSON.stringify(bundle.outputFiles[0]!.text)})(module, module.exports, require);
      module.exports.startEnrollmentFenceIpcDispatcher(process, { instanceId: ${JSON.stringify(instanceId)}, bind: async () => ({
          instanceId: ${JSON.stringify(instanceId)},
          closeAdmission: async () => {},
          createEpoch: () => ${JSON.stringify(epochId)},
          register: () => '123e4567-e89b-42d3-a456-426614174002',
          fenceEpoch: () => 'drained',
          fenceOperation: () => 'drained'
        }) });
    `
      ],
      { execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] }
    );
    process.on("error", () => {});
    try {
      const client = new EnrollmentFenceIpcClient(process);
      await client.ready();
      await client.bind();
      const epoch = await client.createEpoch();
      await client.register(epoch);
      expect(await client.close(2000)).toEqual({
        status: "api_barrier_drained"
      });
    } finally {
      await stop(process);
    }
  });

  it("reports the tracked barrier even when the dispatcher's finish response callback fails", async () => {
    const bundle = await build({
      entryPoints: [
        fileURLToPath(
          new URL(
            "../../shared/src/enrollment-fence-ipc-dispatcher.ts",
            import.meta.url
          )
        )
      ],
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false
    });
    const process = fork(
      "-e",
      [
        `
      new Function('module', 'exports', 'require', ${JSON.stringify(bundle.outputFiles[0]!.text)})(module, module.exports, require);
      let closed = false, fenced = false;
      const send = process.send.bind(process);
      process.send = (wire, callback) => {
        if (JSON.parse(wire).op === 'finish')
          return send(wire, () => callback(new Error('simulated response send failure')));
        return send(wire, callback);
      };
      const dispatcher = module.exports.startEnrollmentFenceIpcDispatcher(process, {
        instanceId: ${JSON.stringify(instanceId)}, bind: async () => ({
          instanceId: ${JSON.stringify(instanceId)},
          closeAdmission: async () => { closed = true; },
          createEpoch: () => ${JSON.stringify(epochId)},
          register: () => '123e4567-e89b-42d3-a456-426614174002',
          fenceEpoch: () => { fenced = true; return 'drained'; },
          fenceOperation: () => 'drained'
        })
      });
      process.on('disconnect', () => setTimeout(() => process.exit(closed && fenced && dispatcher.state() === 'poisoned' && dispatcher.uncertain() ? 0 : 1), 50));
    `
      ],
      { execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] }
    );
    process.on("error", () => {});
    const exited = once(process, "exit");
    try {
      const client = new EnrollmentFenceIpcClient(process);
      await client.ready();
      await client.bind();
      await client.createEpoch();
      expect(await client.close(2000)).toEqual({
        status: "api_barrier_drained"
      });
      expect((await exited)[0]).toBe(0);
    } finally {
      await stop(process);
    }
  });

  it("requires terminal acknowledgement and disconnect", async () => {
    const process = child(
      `process.send(JSON.stringify({v:1,type:'ready',instanceId:${JSON.stringify(instanceId)}})); process.on('message', wire => {});`
    );
    try {
      const client = new EnrollmentFenceIpcClient(process);
      await client.ready();
      await client.bind();
      expect(await client.close(1000)).toEqual({
        status: "api_barrier_drained"
      });
    } finally {
      await stop(process);
    }
  });

  it("requires a terminal response and disconnect even for an empty epoch set", async () => {
    const process = child(`
      process.send(JSON.stringify({v:1,type:'ready',instanceId:${JSON.stringify(instanceId)}}));
      process.on('message', wire => {
        const request = JSON.parse(wire);
        if (request.op !== 'finish') return process.disconnect();
        process.send(JSON.stringify({v:1,type:'response',seq:request.seq,op:'finish',result:{kind:'ok'}}), () => process.disconnect());
      });
    `);
    try {
      const client = new EnrollmentFenceIpcClient(process);
      await client.ready();
      await client.bind();
      expect(await client.close(1000)).toEqual({
        status: "api_barrier_drained"
      });
      expect(() => new EnrollmentFenceIpcClient(process)).toThrow();
    } finally {
      await stop(process);
    }
  });
  it("fails closed when an empty close receives no terminal response", async () => {
    const process = child(
      `process.send(JSON.stringify({v:1,type:'ready',instanceId:${JSON.stringify(instanceId)}})); setInterval(() => {}, 1000);`,
      false
    );
    try {
      const client = new EnrollmentFenceIpcClient(process);
      await client.ready();
      await client.bind();
      expect((await client.close(50)).status).toBe("uncertain");
    } finally {
      await stop(process);
    }
  });

  it("reserves the last sequence for finish", async () => {
    const process = child(
      `process.send(JSON.stringify({v:1,type:'ready',instanceId:${JSON.stringify(instanceId)}})); process.on('message', wire => {});`
    );
    try {
      const client = new EnrollmentFenceIpcClient(process);
      await client.ready();
      await client.bind();
      (client as unknown as { sequence: number }).sequence = 99999;
      await expect(client.createEpoch()).rejects.toThrow();
      expect(await client.close(1000)).toEqual({
        status: "api_barrier_drained"
      });
    } finally {
      await stop(process);
    }
  });

  it("rejects finish send failure even after response and disconnect", async () => {
    const process = child(
      `process.send(JSON.stringify({v:1,type:'ready',instanceId:${JSON.stringify(instanceId)}})); process.on('message', wire => {});`
    );
    try {
      const client = new EnrollmentFenceIpcClient(process);
      await client.ready();
      await client.bind();
      const original = process.send!.bind(process);
      let callback!: (error: Error | null) => void;
      vi.spyOn(process, "send").mockImplementationOnce(((
        message: string,
        cb: (error: Error | null) => void
      ) => {
        callback = cb;
        return original(message);
      }) as typeof process.send);
      const disconnected = once(process, "disconnect");
      const closing = client.close(1000);
      await disconnected;
      callback(new Error("late send error"));
      expect((await closing).status).toBe("uncertain");
    } finally {
      await stop(process);
    }
  });

  it.each(["drain", "finish"])(
    "rejects a duplicate queued after %s",
    async (stage) => {
      const process = child(
        `
      const id = ${JSON.stringify(instanceId)}, epoch = ${JSON.stringify(epochId)}, stage = ${JSON.stringify(stage)};
      process.send(JSON.stringify({v:1,type:'ready',instanceId:id}));
      process.on('message', wire => {
        const r = JSON.parse(wire);
        const result = r.op === 'create' ? {kind:'ok',instanceId:id,epochId:epoch} : r.op === 'finish' ? {kind:'ok'} : {kind:'ok',instanceId:id,epochId:epoch,status:'drained'};
        const response = JSON.stringify({v:1,type:'response',seq:r.seq,op:r.op,result});
        process.send(response);
        if ((stage === 'drain' && r.op === 'fenceEpoch') || (stage === 'finish' && r.op === 'finish')) process.send(response);
        if (r.op === 'finish') process.disconnect();
      });
    `,
        false
      );
      try {
        const client = new EnrollmentFenceIpcClient(process);
        await client.ready();
        await client.bind();
        await client.createEpoch();
        expect((await client.close(1000)).status).toBe("uncertain");
      } finally {
        await stop(process);
      }
    }
  );

  it("rejects another client while the first owns the child", async () => {
    const process = child(
      `process.send(JSON.stringify({v:1,type:'ready',instanceId:${JSON.stringify(instanceId)}})); setInterval(() => {}, 1000);`
    );
    try {
      const client = new EnrollmentFenceIpcClient(process);
      await client.ready();
      await client.bind();
      expect(() => new EnrollmentFenceIpcClient(process)).toThrow();
    } finally {
      await stop(process);
    }
  });

  it("requires lifecycle owner error handling before binding", async () => {
    const process = child("setInterval(() => {}, 1000)");
    process.removeAllListeners("error");
    try {
      expect(() => new EnrollmentFenceIpcClient(process)).toThrow();
    } finally {
      process.on("error", () => {});
      await stop(process);
    }
  });

  it("does not accept a response until its send callback succeeds", async () => {
    const process = child(`
      process.send(JSON.stringify({v:1,type:'ready',instanceId:${JSON.stringify(instanceId)}}));
      process.on('message', wire => {
        const r = JSON.parse(wire);
        process.send(JSON.stringify({v:1,type:'response',seq:r.seq,op:r.op,result:{kind:'ok',instanceId:${JSON.stringify(instanceId)},epochId:${JSON.stringify(epochId)}}}));
      });
    `);
    try {
      const client = new EnrollmentFenceIpcClient(process);
      await client.ready();
      await client.bind();
      const original = process.send!.bind(process);
      let callback: ((error: Error | null) => void) | undefined;
      vi.spyOn(process, "send").mockImplementation(((
        message: string,
        cb: (error: Error | null) => void
      ) => {
        callback = cb;
        return original(message);
      }) as typeof process.send);
      const received = once(process, "message");
      const create = client.createEpoch();
      await received;
      let settled = false;
      void create.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      await Promise.resolve();
      expect(settled).toBe(false);
      callback!(new Error("send failed"));
      await expect(create).rejects.toThrow();
      expect((await client.close(1000)).status).toBe("uncertain");
    } finally {
      await stop(process);
    }
  });

  it("poisons if a duplicate arrives while the send callback is pending", async () => {
    const process = child(`
      process.send(JSON.stringify({v:1,type:'ready',instanceId:${JSON.stringify(instanceId)}}));
      process.on('message', wire => {
        const r = JSON.parse(wire);
        const response = JSON.stringify({v:1,type:'response',seq:r.seq,op:r.op,result:{kind:'ok',instanceId:${JSON.stringify(instanceId)},epochId:${JSON.stringify(epochId)}}});
        process.send(response);
        process.send(response);
      });
    `);
    try {
      const client = new EnrollmentFenceIpcClient(process);
      await client.ready();
      await client.bind();
      const original = process.send!.bind(process);
      vi.spyOn(process, "send").mockImplementationOnce(((message: string) =>
        original(message)) as typeof process.send);
      await expect(client.createEpoch()).rejects.toThrow();
      expect((await client.close(1000)).status).toBe("uncertain");
    } finally {
      await stop(process);
    }
  });

  it("accepts a response after the delayed send callback succeeds", async () => {
    const process = child(`
      process.send(JSON.stringify({v:1,type:'ready',instanceId:${JSON.stringify(instanceId)}}));
      process.on('message', wire => {
        const r = JSON.parse(wire);
        process.send(JSON.stringify({v:1,type:'response',seq:r.seq,op:r.op,result:r.op === 'create' ? {kind:'ok',instanceId:${JSON.stringify(instanceId)},epochId:${JSON.stringify(epochId)}} : {kind:'ok',instanceId:${JSON.stringify(instanceId)},epochId:${JSON.stringify(epochId)},status:'drained'}}));
      });
    `);
    try {
      const client = new EnrollmentFenceIpcClient(process);
      await client.ready();
      await client.bind();
      const original = process.send!.bind(process);
      let callback: ((error: Error | null) => void) | undefined;
      const spy = vi.spyOn(process, "send").mockImplementationOnce(((
        message: string,
        cb: (error: Error | null) => void
      ) => {
        callback = cb;
        return original(message);
      }) as typeof process.send);
      const response = once(process, "message");
      const created = client.createEpoch();
      await response;
      callback!(null);
      expect(await created).toEqual({ instanceId, epochId });
      spy.mockRestore();
      expect(await client.close(1000)).toEqual({
        status: "api_barrier_drained"
      });
    } finally {
      await stop(process);
    }
  });

  it("retains owner error handling after close and poison", async () => {
    for (const poison of [false, true]) {
      const process = child(
        `process.send(JSON.stringify({v:1,type:'ready',instanceId:${JSON.stringify(instanceId)}})); setInterval(() => {}, 1000);`
      );
      const owner = vi.fn();
      process.on("error", owner);
      try {
        const client = new EnrollmentFenceIpcClient(process);
        await client.ready();
        await client.bind();
        if (poison) process.emit("message", "invalid", undefined);
        await client.close(1000);
        const error = new Error("late child error");
        process.emit("error", error);
        expect(owner).toHaveBeenCalledWith(error);
      } finally {
        await stop(process);
      }
    }
  });

  it("keeps a fallback error listener if the owner removes its listener early", async () => {
    const process = child(
      `process.send(JSON.stringify({v:1,type:'ready',instanceId:${JSON.stringify(instanceId)}})); setInterval(() => {}, 1000);`
    );
    const owner = process.listeners("error")[0]!;
    try {
      const client = new EnrollmentFenceIpcClient(process);
      await client.ready();
      await client.bind();
      await client.close(1000);
      process.removeListener("error", owner);
      expect(() => process.emit("error", new Error("late"))).not.toThrow();
    } finally {
      await stop(process);
    }
  });

  it("closes an unexpected transferred server handle", async () => {
    const process = child(`
      const net = require('node:net');
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => process.send(JSON.stringify({v:1,type:'ready',instanceId:${JSON.stringify(instanceId)}}), server, () => server.close()));
      setInterval(() => {}, 1000);
    `);
    try {
      let received: Server | undefined;
      process.on("message", (_wire, handle) => {
        if (handle instanceof Server) received = handle;
      });
      const client = new EnrollmentFenceIpcClient(process);
      await expect(client.ready()).rejects.toThrow();
      expect(received).toBeInstanceOf(Server);
      expect(received!.listening).toBe(false);
      expect((await client.close(1000)).status).toBe("uncertain");
    } finally {
      await stop(process);
    }
  });
  it("fences created epochs before reporting the tracked barrier drained", async () => {
    const process = child(`
      const id = ${JSON.stringify(instanceId)}, epoch = ${JSON.stringify(epochId)};
      process.send(JSON.stringify({v:1,type:'ready',instanceId:id}));
      process.on('message', wire => {
        const request = JSON.parse(wire);
        const result = request.op === 'create'
          ? {kind:'ok',instanceId:id,epochId:epoch}
          : {kind:'ok',instanceId:id,epochId:epoch,status:'drained'};
        process.send(JSON.stringify({v:1,type:'response',seq:request.seq,op:request.op,result}));
      });
    `);
    try {
      const client = new EnrollmentFenceIpcClient(process);
      await client.ready();
      await client.bind();
      expect(await client.createEpoch()).toEqual({ instanceId, epochId });
      expect(await client.close(2000)).toEqual({
        status: "api_barrier_drained"
      });
    } finally {
      await stop(process);
    }
  });

  it("waits for an admitted create even when close races its response", async () => {
    const process = child(`
      const id = ${JSON.stringify(instanceId)}, epoch = ${JSON.stringify(epochId)};
      process.send(JSON.stringify({v:1,type:'ready',instanceId:id}));
      process.on('message', wire => {
        const r = JSON.parse(wire);
        const result = r.op === 'create' ? {kind:'ok',instanceId:id,epochId:epoch} : {kind:'ok',instanceId:id,epochId:epoch,status:'drained'};
        process.send(JSON.stringify({v:1,type:'response',seq:r.seq,op:r.op,result}));
      });
    `);
    try {
      const client = new EnrollmentFenceIpcClient(process);
      await client.ready();
      await client.bind();
      const created = client.createEpoch();
      const closing = client.close(2000);
      await expect(client.createEpoch()).rejects.toThrow();
      expect(await created).toEqual({ instanceId, epochId });
      expect(await closing).toEqual({ status: "api_barrier_drained" });
    } finally {
      await stop(process);
    }
  });

  it("permanently poisons on unknown create outcome and ignores late evidence", async () => {
    const process = child(`
      const id = ${JSON.stringify(instanceId)}, epoch = ${JSON.stringify(epochId)};
      process.send(JSON.stringify({v:1,type:'ready',instanceId:id}));
      process.on('message', wire => {
        const r = JSON.parse(wire);
        setTimeout(() => process.send(JSON.stringify({v:1,type:'response',seq:r.seq,op:r.op,result:{kind:'ok',instanceId:id,epochId:epoch}})), 400);
      });
    `);
    try {
      const client = new EnrollmentFenceIpcClient(process, 200);
      await client.ready();
      await client.bind();
      await expect(client.createEpoch()).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await client.close(1000)).status).toBe("uncertain");
      await expect(client.createEpoch()).rejects.toThrow();
    } finally {
      await stop(process);
    }
  });

  it("correlates out-of-order registration responses to their epochs", async () => {
    const process = child(`
      const id = ${JSON.stringify(instanceId)}, epochs = [${JSON.stringify(epochId)}, '123e4567e89b42d3a456426614174001-0000000000000002'];
      let creates = 0, registrations = [];
      process.send(JSON.stringify({v:1,type:'ready',instanceId:id}));
      process.on('message', wire => {
        const r = JSON.parse(wire);
        const reply = result => process.send(JSON.stringify({v:1,type:'response',seq:r.seq,op:r.op,result}));
        if (r.op === 'create') return reply({kind:'ok',instanceId:id,epochId:epochs[creates++]});
        if (r.op === 'register') {
          registrations.push(() => reply({kind:'ok',...r.args,operationId:r.args.epochId.endsWith('1') ? '123e4567-e89b-42d3-a456-426614174002' : '123e4567-e89b-42d3-a456-426614174003'}));
          if (registrations.length === 2) registrations.reverse().forEach(send => send());
          return;
        }
        reply({kind:'ok',...r.args,status:'drained'});
      });
    `);
    try {
      const client = new EnrollmentFenceIpcClient(process);
      await client.ready();
      await client.bind();
      const first = await client.createEpoch();
      const second = await client.createEpoch();
      const [a, b] = await Promise.all([
        client.register(first),
        client.register(second)
      ]);
      expect(a).toEqual({
        ...first,
        operationId: "123e4567-e89b-42d3-a456-426614174002"
      });
      expect(b).toEqual({
        ...second,
        operationId: "123e4567-e89b-42d3-a456-426614174003"
      });
      expect(await client.fenceOperation(a)).toBe("drained");
      expect(await client.close(2000)).toEqual({
        status: "api_barrier_drained"
      });
    } finally {
      await stop(process);
    }
  });

  it("waits for pending registration before fencing on close", async () => {
    const process = child(`
      const id = ${JSON.stringify(instanceId)}, epoch = ${JSON.stringify(epochId)};
      let registered = false;
      process.send(JSON.stringify({v:1,type:'ready',instanceId:id}));
      process.on('message', wire => {
        const r = JSON.parse(wire);
        const reply = result => process.send(JSON.stringify({v:1,type:'response',seq:r.seq,op:r.op,result}));
        if (r.op === 'create') return reply({kind:'ok',instanceId:id,epochId:epoch});
        if (r.op === 'register') return setTimeout(() => { registered = true; reply({kind:'ok',instanceId:id,epochId:epoch,operationId:'123e4567-e89b-42d3-a456-426614174002'}); }, 50);
        if (!registered) return process.disconnect();
        reply({kind:'ok',instanceId:id,epochId:epoch,status:'drained'});
      });
    `);
    try {
      const client = new EnrollmentFenceIpcClient(process);
      await client.ready();
      await client.bind();
      const epoch = await client.createEpoch();
      const registration = client.register(epoch);
      const closing = client.close(2000);
      await expect(client.register(epoch)).rejects.toThrow();
      expect((await registration).epochId).toBe(epochId);
      expect(await closing).toEqual({ status: "api_barrier_drained" });
    } finally {
      await stop(process);
    }
  });

  it.each(["register", "fenceEpoch", "fenceOperation"])(
    "poisons on wrong identities in %s responses",
    async (target) => {
      const process = child(`
      const id = ${JSON.stringify(instanceId)}, epoch = ${JSON.stringify(epochId)}, target = ${JSON.stringify(target)};
      process.send(JSON.stringify({v:1,type:'ready',instanceId:id}));
      process.on('message', wire => {
        const r = JSON.parse(wire);
        let result = {kind:'ok',instanceId:id,epochId:epoch};
        if (r.op === 'register' || r.op === 'fenceOperation') result.operationId = '123e4567-e89b-42d3-a456-426614174002';
        if (r.op.startsWith('fence')) result.status = 'drained';
        if (r.op === target) result.epochId = '123e4567e89b42d3a456426614174001-0000000000000002';
        process.send(JSON.stringify({v:1,type:'response',seq:r.seq,op:r.op,result}));
      });
    `);
      try {
        const client = new EnrollmentFenceIpcClient(process);
        await client.ready();
        await client.bind();
        const epoch = await client.createEpoch();
        if (target === "register")
          await expect(client.register(epoch)).rejects.toThrow();
        else if (target === "fenceEpoch")
          await expect(client.fenceEpoch(epoch)).rejects.toThrow();
        else {
          const operation = await client.register(epoch);
          await expect(client.fenceOperation(operation)).rejects.toThrow();
        }
        expect((await client.close(1000)).status).toBe("uncertain");
      } finally {
        await stop(process);
      }
    }
  );

  it("correlates concurrent fence responses and fences epochs again on close", async () => {
    const process = child(`
      const id = ${JSON.stringify(instanceId)}, epoch = ${JSON.stringify(epochId)};
      let fences = [];
      process.send(JSON.stringify({v:1,type:'ready',instanceId:id}));
      process.on('message', wire => {
        const r = JSON.parse(wire);
        const reply = status => process.send(JSON.stringify({v:1,type:'response',seq:r.seq,op:r.op,result:{kind:'ok',instanceId:id,epochId:epoch,...(status ? {status} : {})}}));
        if (r.op === 'create') return reply();
        fences.push(reply);
        if (fences.length === 2) { fences[1]('drained'); fences[0]('pending'); }
        if (fences.length === 3) reply('drained');
      });
    `);
    try {
      const client = new EnrollmentFenceIpcClient(process);
      await client.ready();
      await client.bind();
      const epoch = await client.createEpoch();
      expect(
        await Promise.all([client.fenceEpoch(epoch), client.fenceEpoch(epoch)])
      ).toEqual(["pending", "drained"]);
      expect(await client.close(1000)).toEqual({
        status: "api_barrier_drained"
      });
    } finally {
      await stop(process);
    }
  });

  it("polls pending fences and shares the first close result", async () => {
    const process = child(`
      const id = ${JSON.stringify(instanceId)}, epoch = ${JSON.stringify(epochId)};
      let polls = 0;
      process.send(JSON.stringify({v:1,type:'ready',instanceId:id}));
      process.on('message', wire => {
        const r = JSON.parse(wire);
        const result = r.op === 'create' ? {kind:'ok',instanceId:id,epochId:epoch} : {kind:'ok',instanceId:id,epochId:epoch,status:++polls === 1 ? 'pending' : 'drained'};
        process.send(JSON.stringify({v:1,type:'response',seq:r.seq,op:r.op,result}));
      });
    `);
    try {
      const client = new EnrollmentFenceIpcClient(process);
      await client.ready();
      await client.bind();
      await client.createEpoch();
      const first = client.close(2000);
      expect(client.close(1)).toBe(first);
      expect(await first).toEqual({ status: "api_barrier_drained" });
    } finally {
      await stop(process);
    }
  });

  it("reports uncertainty when a pending epoch never drains before close deadline", async () => {
    const process = child(`
      const id = ${JSON.stringify(instanceId)}, epoch = ${JSON.stringify(epochId)};
      process.send(JSON.stringify({v:1,type:'ready',instanceId:id}));
      process.on('message', wire => {
        const r = JSON.parse(wire);
        const result = r.op === 'create' ? {kind:'ok',instanceId:id,epochId:epoch} : {kind:'ok',instanceId:id,epochId:epoch,status:'pending'};
        process.send(JSON.stringify({v:1,type:'response',seq:r.seq,op:r.op,result}));
      });
    `);
    try {
      const client = new EnrollmentFenceIpcClient(process);
      await client.ready();
      await client.bind();
      await client.createEpoch();
      expect((await client.close(50)).status).toBe("uncertain");
    } finally {
      await stop(process);
    }
  });

  it.each(["duplicate", "wrongIdentity", "disconnect"])(
    "poisons on %s response",
    async (mode) => {
      const process = child(`
      const id = ${JSON.stringify(instanceId)}, epoch = ${JSON.stringify(epochId)}, mode = ${JSON.stringify(mode)};
      process.send(JSON.stringify({v:1,type:'ready',instanceId:id}));
      process.on('message', wire => {
        const r = JSON.parse(wire);
        if (mode === 'disconnect') return process.disconnect();
        const result = {kind:'ok',instanceId:mode === 'wrongIdentity' ? '123e4567-e89b-42d3-a456-426614174099' : id,epochId:epoch};
        const response = JSON.stringify({v:1,type:'response',seq:r.seq,op:r.op,result});
        process.send(response);
        if (mode === 'duplicate') process.send(response);
      });
    `);
      try {
        const client = new EnrollmentFenceIpcClient(process, 1000);
        await client.ready();
        await client.bind();
        await client.createEpoch().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect((await client.close(1000)).status).toBe("uncertain");
      } finally {
        await stop(process);
      }
    }
  );
});
