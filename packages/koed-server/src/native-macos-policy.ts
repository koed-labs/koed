// Keep in sync with scripts/native-runtime/core-artifact.mjs macOS staging policy.
const executables = new Set(
  `clusterdb createdb createuser dropdb dropuser ecpg initdb oid2name pg_amcheck pg_archivecleanup pg_basebackup pg_checksums pg_combinebackup pg_config pg_controldata pg_createsubscriber pg_ctl pg_dump pg_dumpall pg_isready pg_receivewal pg_recvlogical pg_resetwal pg_restore pg_rewind pg_test_fsync pg_test_timing pg_upgrade pg_verifybackup pg_waldump pg_walsummary pgbench postgres postmaster psql reindexdb vacuumdb vacuumlo`.split(
    " "
  )
);
const shareFiles = new Set(
  `errcodes.txt information_schema.sql pg_hba.conf.sample pg_ident.conf.sample pg_service.conf.sample postgres.bki postgresql.conf.sample psqlrc.sample snowball_create.sql sql_features.txt system_constraints.sql system_functions.sql system_views.sql`.split(
    " "
  )
);

export function permitsMacFilePath(path: string): boolean {
  if (
    [
      "native-core-manifest.json",
      "runtime-asset-manifest.json",
      "llama.cpp/llama-server"
    ].includes(path)
  )
    return true;
  if (path.startsWith("postgres/bin/"))
    return executables.has(path.slice("postgres/bin/".length));
  if (path.startsWith("postgres/lib/"))
    return (
      /\.(?:so|dylib)$/i.test(path) ||
      /^postgres\/lib\/(?:postgresql\/)?pkgconfig\/[\w.-]+\.pc$/.test(path) ||
      /^postgres\/lib\/(?:postgresql\/)?pgxs\/config\/(?:install-sh|missing)$/.test(
        path
      )
    );
  if (path.startsWith("llama.cpp/metal/"))
    return /^llama\.cpp\/metal\/(?:llama-server|LICENSE|ggml-metal\.metal|[\w.+-]+\.dylib)$/.test(
      path
    );
  if (path.startsWith("third-party-licenses/"))
    return /(?:^|\/|__)(?:LICEN[CS]E|NOTICE|COPYING|COPYRIGHT)(?:[._-][\w.-]+)?$/i.test(
      path
    );
  if (!path.startsWith("postgres/share/")) return false;
  const shared = path
    .slice("postgres/share/".length)
    .replace(/^postgresql\//, "");
  return (
    shareFiles.has(shared) ||
    /^extension\/[\w.-]+\.(?:sql|control)$/.test(shared) ||
    /^timezone\/[\w.+/-]+$/.test(shared) ||
    /^timezonesets\/(?:Africa|America|Antarctica|Asia|Atlantic|Australia|Default|Etc|Europe|India|Indian|Pacific)(?:\.txt)?$/.test(
      shared
    ) ||
    /^tsearch_data\/[\w.-]+\.(?:stop|affix|dict|ths|syn|rules)$/.test(shared) ||
    /^man\/man[1-9]\/[\w.+-]+\.[1-9](?:\.gz)?$/.test(shared) ||
    /^locale\/[\w@.-]+\/LC_MESSAGES\/[\w.+-]+\.mo$/.test(shared) ||
    /^doc\/[\w./+-]+\.(?:html|css|png|svg|txt|pdf|example)$/.test(shared)
  );
}

export function validateMacFile(
  path: string,
  header: Buffer,
  mode: number
): void {
  const magic = header.subarray(0, 4).toString("hex");
  const arm64 =
    header.length >= 16 &&
    magic === "cffaedfe" &&
    header.readUInt32LE(4) === 0x0100000c;
  const library = /\.(?:so|dylib)$/i.test(path);
  const validType =
    arm64 &&
    (library
      ? [6, 8].includes(header.readUInt32LE(12))
      : header.readUInt32LE(12) === 2);
  const binaryPath =
    (path.startsWith("postgres/bin/") && executables.has(path.slice(13))) ||
    (path.startsWith("postgres/lib/") && library) ||
    (path.startsWith("llama.cpp/metal/") &&
      (path === "llama.cpp/metal/llama-server" || /\.dylib$/i.test(path)));
  const macho = [
    "cffaedfe",
    "feedfacf",
    "cafebabe",
    "bebafeca",
    "cafebabf",
    "bfbafeca",
    "cefaedfe",
    "feedface"
  ].includes(magic);
  const foreign =
    magic === "7f454c46" ||
    header.subarray(0, 2).toString() === "MZ" ||
    /\.(?:exe|dll|so\.\d+(?:\.\d+)*)$/i.test(path) ||
    /(?:^|\/)libcu(?:da|blas|dart)/i.test(path);
  const script =
    (path === "llama.cpp/llama-server" ||
      /^postgres\/lib\/(?:postgresql\/)?pgxs\/config\/(?:install-sh|missing)$/.test(
        path
      )) &&
    header.subarray(0, 2).toString() === "#!";
  const timezone = /^postgres\/share\/(?:postgresql\/)?timezone\//.test(path);
  if (
    !permitsMacFilePath(path) ||
    (timezone && magic !== "545a6966") ||
    foreign ||
    (macho && (!validType || !binaryPath)) ||
    (library && !validType) ||
    (path.startsWith("postgres/bin/") && !validType) ||
    ((mode & 0o111) !== 0 && !arm64 && !script)
  )
    throw new Error(`Invalid macOS native file or executable: ${path}`);
}
