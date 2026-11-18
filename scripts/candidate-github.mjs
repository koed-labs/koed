import { createWriteStream } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const prefix = "/repos/koed-labs/koed/";
const endpoint =
  /^(?:git\/ref\/heads\/main|branches\/main|pulls\/[1-9]\d*|actions\/runs\/[1-9]\d*(?:\/artifacts\?per_page=100&page=[1-9]\d*)?|environments\/desktop-candidate-signing(?:\/deployment-branch-policies)?)$/;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

export const candidateGithub = (token, fetcher = fetch) => {
  if (typeof token !== "string" || !token)
    throw new Error("GitHub token missing");
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const api = async (path) => {
    if (
      typeof path !== "string" ||
      !path.startsWith(prefix) ||
      !endpoint.test(path.slice(prefix.length))
    )
      throw new Error("Unsupported GitHub endpoint");
    const response = await fetcher(`https://api.github.com${path}`, {
      headers,
      redirect: "error"
    });
    if (!response.ok)
      throw new Error(`GitHub API request failed (${response.status})`);
    const size = Number(response.headers.get("content-length") || 0);
    if (size > 5 * 1024 * 1024)
      throw new Error("GitHub API response too large");
    const text = await response.text();
    if (text.length > 5 * 1024 * 1024)
      throw new Error("GitHub API response too large");
    return JSON.parse(text);
  };
  const downloadArtifact = async (id, output, limit) => {
    if (!positiveInteger(id) || !positiveInteger(limit))
      throw new Error("Invalid artifact request");
    const redirect = await fetcher(
      `https://api.github.com${prefix}actions/artifacts/${id}/zip`,
      { headers, redirect: "manual" }
    );
    const location = redirect.headers.get("location");
    if (redirect.status !== 302 || !location)
      throw new Error("GitHub artifact redirect unavailable");
    const url = new URL(location);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Invalid artifact redirect");
    const response = await fetcher(url.href, {
      headers: {},
      redirect: "error"
    });
    if (!response.ok || !response.body)
      throw new Error(`Artifact download failed (${response.status})`);
    const size = Number(response.headers.get("content-length") || 0);
    if (size > limit) throw new Error("Artifact download exceeds size limit");
    let file;
    try {
      file = await open(output, "wx", 0o600);
      let count = 0;
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          count += chunk.length;
          if (count > limit)
            return callback(new Error("Artifact download exceeds size limit"));
          callback(null, chunk);
        }
      });
      await pipeline(
        Readable.fromWeb(response.body),
        meter,
        createWriteStream(output, { fd: file.fd, autoClose: false })
      );
    } catch (error) {
      if (file) {
        try {
          await unlink(output);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Artifact download cleanup failed",
            { cause: cleanupError }
          );
        }
      }
      throw error;
    } finally {
      if (file) await file.close();
    }
  };
  return Object.freeze({ api, downloadArtifact });
};
