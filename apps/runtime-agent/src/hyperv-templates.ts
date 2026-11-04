import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  hyperVTemplateProofSchema,
  type HyperVTemplateProof,
} from "@hitchlet/contracts/internal";
const descriptorSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    exportRoot: z.string().refine(isAbsolute),
    configRelativePath: z.string().min(1),
    guestOs: z.enum(["windows", "linux"]),
    generation: z.union([z.literal(1), z.literal(2)]),
  })
  .strict();
const fileSchema = z
  .object({
    path: z.string(),
    size: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    dev: z.string(),
    ino: z.string(),
    mtimeNs: z.string(),
    ctimeNs: z.string(),
  })
  .strict();
const recordSchema = z
  .object({
    namespace: z.string().uuid(),
    root: z.string(),
    rootDev: z.string(),
    rootIno: z.string(),
    proof: hyperVTemplateProofSchema,
    files: z.array(fileSchema).min(2),
  })
  .strict();
type FileProof = z.infer<typeof fileSchema>;
const canonical = (value: unknown) => JSON.stringify(value);
async function regularFiles(root: string): Promise<string[]> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw Error("Hyper-V export root must be a normal directory");
  const result: string[] = [];
  async function visit(directory: string) {
    for (const e of await readdir(directory, { withFileTypes: true })) {
      const p = join(directory, e.name);
      if (e.isSymbolicLink())
        throw Error("Hyper-V export links are unsupported");
      if (e.isDirectory()) await visit(p);
      else if (e.isFile()) result.push(relative(root, p));
      else throw Error("Hyper-V export contains a non-file entry");
    }
  }
  await visit(root);
  return result.sort();
}
async function fileIdentity(path: string) {
  const s = await lstat(path, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink())
    throw Error("Hyper-V template file changed");
  return {
    size: String(s.size),
    dev: String(s.dev),
    ino: String(s.ino),
    mtimeNs: String(s.mtimeNs),
    ctimeNs: String(s.ctimeNs),
  };
}
/** Stream all files once at explicit seal time, not on the ticket's critical path. */
export async function hashHyperVExport(root: string): Promise<FileProof[]> {
  const paths = await regularFiles(root),
    out: FileProof[] = [];
  for (const path of paths) {
    const full = join(root, path),
      before = await fileIdentity(full),
      h = createHash("sha256");
    for await (const chunk of createReadStream(full)) h.update(chunk);
    const after = await fileIdentity(full);
    if (canonical(before) !== canonical(after))
      throw Error("Hyper-V export changed while sealing");
    out.push({ path, ...before, sha256: h.digest("hex") });
  }
  if (canonical(paths) !== canonical(await regularFiles(root)))
    throw Error("Hyper-V export changed while sealing");
  return out;
}
function digest(
  proof: Pick<HyperVTemplateProof, "name" | "template">,
  files: FileProof[],
) {
  return (
    "sha256:" +
    createHash("sha256")
      .update(
        canonical({
          name: proof.name,
          guestOs: proof.template.guestOs,
          architecture: proof.template.architecture,
          generation: proof.template.generation,
          files: files.map((f) => ({
            path: f.path.split(sep).join("/"),
            size: f.size,
            sha256: f.sha256,
          })),
        }),
      )
      .digest("hex")
  );
}
export class HyperVTemplateRegistry {
  constructor(
    private readonly directory: string,
    private readonly namespace: string,
  ) {}
  async seal(raw: unknown): Promise<HyperVTemplateProof> {
    const d = descriptorSchema.parse(raw),
      root = resolve(d.exportRoot),
      config = resolve(root, d.configRelativePath);
    if (
      !config.startsWith(root + sep) ||
      !config.toLowerCase().endsWith(".vmcx")
    )
      throw Error(
        "Template config must be within its self-contained stopped export",
      );
    const files = await hashHyperVExport(root),
      entry = files.find((f) => f.path === relative(root, config));
    if (!entry || !files.some((f) => f.path.toLowerCase().endsWith(".vhdx")))
      throw Error("Hyper-V export needs config and full VHDX payload");
    // Operators export a stopped, self-contained VM. External parent disks and
    // running/saved export semantics are not supported by this first recipe.
    const base = {
      name: d.name,
      template: {
        configPath: config,
        configSha256: entry.sha256,
        guestOs: d.guestOs,
        architecture: "amd64" as const,
        generation: d.generation,
      },
    };
    const proof = hyperVTemplateProofSchema.parse({
      ...base,
      artifactDigest: digest(base, files),
      proofKind: "sealed_export_bundle_v1",
      sealedAt: new Date().toISOString(),
    });
    const info = await stat(root, { bigint: true });
    const record = recordSchema.parse({
      namespace: this.namespace,
      root,
      rootDev: String(info.dev),
      rootIno: String(info.ino),
      proof,
      files,
    });
    await mkdir(this.directory, { recursive: true });
    const target = join(this.directory, d.name + ".json"),
      temporary = target + "." + process.pid + ".tmp";
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(canonical(record) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, target);
    return proof;
  }
  async facts(): Promise<HyperVTemplateProof[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const result: HyperVTemplateProof[] = [];
    for (const name of names.filter((n) =>
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/.test(n),
    )) {
      try {
        const r = recordSchema.parse(
          JSON.parse(await readFile(join(this.directory, name), "utf8")),
        );
        if (
          r.namespace !== this.namespace ||
          name !== r.proof.name + ".json" ||
          digest(r.proof, r.files) !== r.proof.artifactDigest
        )
          continue;
        const rootInfo = await lstat(r.root, { bigint: true });
        if (
          !rootInfo.isDirectory() ||
          rootInfo.isSymbolicLink() ||
          String(rootInfo.dev) !== r.rootDev ||
          String(rootInfo.ino) !== r.rootIno
        )
          continue;
        if (
          canonical(await regularFiles(r.root)) !==
          canonical(r.files.map((f) => f.path))
        )
          continue;
        const config = resolve(r.proof.template.configPath),
          configEntry = r.files.find(
            (f) => f.path === relative(r.root, config),
          );
        if (
          !config.startsWith(r.root + sep) ||
          !configEntry ||
          configEntry.sha256 !== r.proof.template.configSha256
        )
          continue;
        let same = true;
        for (const f of r.files) {
          const { path, sha256, ...expected } = f;
          if (
            canonical(await fileIdentity(join(r.root, path))) !==
            canonical(expected)
          ) {
            same = false;
            break;
          }
        }
        if (same) result.push(r.proof);
      } catch {
        /* An unavailable/changed sealed export is omitted, never silently resealed. */
      }
    }
    return result;
  }
}
