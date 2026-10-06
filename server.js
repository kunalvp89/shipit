require("dotenv").config();

const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
const path = require("path");
const fs = require("fs/promises");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 25);
const MAX_FILES = Number(process.env.MAX_FILES || 500);
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 5);
const RUN_BUILD_CHECK = process.env.RUN_BUILD_CHECK === "true";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function requireGithubConfig() {
  const missing = ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO", "GITHUB_BRANCH"]
    .filter((key) => !process.env[key]);

  if (missing.length) {
    throw new Error(`Missing server environment variables: ${missing.join(", ")}`);
  }
}

function githubHeaders() {
  // The token is deliberately read here, server-side, at request time.
  // It is never accepted from the browser.
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ShipIt/0.2.0",
  };
}

async function githubRequest(endpoint, options = {}) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    ...options,
    headers: { ...githubHeaders(), ...(options.headers || {}) },
  });

  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw }; }

  if (!response.ok) {
    const error = new Error(data?.message || `GitHub API error (${response.status})`);
    error.status = response.status;
    throw error;
  }

  return data;
}

function vercelConfigured() {
  return Boolean(process.env.VERCEL_TOKEN && process.env.VERCEL_PROJECT_ID);
}

function vercelHeaders() {
  return {
    Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function vercelRequest(endpoint) {
  const response = await fetch(`https://api.vercel.com${endpoint}`, {
    headers: vercelHeaders(),
  });

  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw }; }

  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.message || `Vercel API error (${response.status})`);
    error.status = response.status;
    throw error;
  }

  return data;
}

async function findLatestVercelDeployment() {
  if (!vercelConfigured()) return null;

  const project = encodeURIComponent(process.env.VERCEL_PROJECT_ID);
  const team = process.env.VERCEL_TEAM_ID
    ? `&teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}`
    : "";

  const data = await vercelRequest(`/v6/deployments?projectId=${project}&limit=1${team}`);
  const deployment = data.deployments?.[0];

  if (!deployment) return null;

  return {
    id: deployment.uid,
    state: deployment.state,
    url: deployment.url ? `https://${deployment.url}` : null,
    createdAt: deployment.created,
    readyAt: deployment.ready,
  };
}

function normalizeZipPath(input) {
  const normalized = input.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);

  if (!parts.length || parts.includes("..") || parts.some((p) => p === ".")) {
    throw new Error(`Unsafe ZIP path: ${input}`);
  }

  return parts.join("/");
}

function shouldSkip(filePath) {
  const lower = filePath.toLowerCase();

  if (
    lower === ".env" ||
    lower.startsWith(".env.") ||
    lower.startsWith(".git/") ||
    lower.startsWith("node_modules/") ||
    lower.startsWith(".next/") ||
    lower.startsWith("dist/") ||
    lower.startsWith("build/")
  ) return true;

  const basename = lower.split("/").pop();

  return [
    ".ds_store",
    "thumbs.db",
    "npm-debug.log",
    "yarn-error.log",
    "pnpm-debug.log",
  ].includes(basename);
}

function extractProject(zipBuffer) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  if (!entries.length) throw new Error("The ZIP file is empty.");
  if (entries.length > MAX_FILES * 3) {
    throw new Error(`ZIP contains too many entries. Limit is ${MAX_FILES} project files.`);
  }

  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const filePath = normalizeZipPath(entry.entryName);
    if (shouldSkip(filePath)) continue;

    const content = entry.getData();

    if (content.length > MAX_FILE_SIZE_MB * 1024 * 1024) {
      throw new Error(`File "${filePath}" exceeds the ${MAX_FILE_SIZE_MB} MB per-file limit.`);
    }

    files.push({ path: filePath, content, size: content.length });

    if (files.length > MAX_FILES) {
      throw new Error(`Project contains more than ${MAX_FILES} files.`);
    }
  }

  if (!files.length) throw new Error("No deployable files were found in the ZIP.");
  return files;
}

function validateProject(files) {
  const warnings = [];
  const packageFile = files.find((f) => f.path === "package.json");

  if (!packageFile) {
    warnings.push("No package.json found. This may not be a Node.js project.");
    return { warnings, packageJson: null };
  }

  let pkg;
  try {
    pkg = JSON.parse(packageFile.content.toString("utf8"));
  } catch {
    throw new Error("package.json exists but is not valid JSON.");
  }

  if (!pkg.scripts?.build) warnings.push("package.json has no build script.");
  if (!pkg.scripts?.start) warnings.push("package.json has no start script.");

  return { warnings, packageJson: pkg };
}

function buildTreeEntries(files, blobs) {
  return files.map((file, index) => ({
    path: file.path,
    mode: "100644",
    type: "blob",
    sha: blobs[index].sha,
  }));
}

async function shipToGithub({ files, owner, repo, branch, message }) {
  const ref = await githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`
  );

  const parentSha = ref.object.sha;

  const parentCommit = await githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${parentSha}`
  );

  const blobs = [];
  for (const file of files) {
    blobs.push(await githubRequest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: file.content.toString("base64"),
          encoding: "base64",
        }),
      }
    ));
  }

  const tree = await githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base_tree: parentCommit.tree.sha,
        tree: buildTreeEntries(files, blobs),
      }),
    }
  );

  const commit = await githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        tree: tree.sha,
        parents: [parentSha],
      }),
    }
  );

  await githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${encodeURIComponent(branch)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: commit.sha, force: false }),
    }
  );

  return {
    commitSha: commit.sha,
    commitUrl: commit.html_url,
    branch,
    repositoryUrl: `https://github.com/${owner}/${repo}`,
  };
}

function runCommand(command, args, cwd, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: {
        ...process.env,
        CI: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 12000) stdout = stdout.slice(-12000);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        return reject(new Error("Build check timed out after 120 seconds."));
      }

      resolve({ code, stdout, stderr });
    });
  });
}

async function buildCheck(files, packageJson) {
  if (!RUN_BUILD_CHECK) {
    return { enabled: false, passed: null, message: "Build check disabled." };
  }

  if (!packageJson?.scripts?.build) {
    return { enabled: true, passed: false, message: "Build check requested, but no build script exists." };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shipit-"));

  try {
    for (const file of files) {
      const target = path.join(tempDir, file.path);
      const relative = path.relative(tempDir, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Unsafe extracted path.");
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content);
    }

    await fs.writeFile(
      path.join(tempDir, "package.json"),
      Buffer.from(JSON.stringify(packageJson, null, 2))
    );

    // npm install is intentionally disabled in v0.2 to avoid arbitrary dependency
    // execution in a public server. The build check expects dependencies to be
    // available in the deployment environment. v0.3 can add an isolated sandbox.
    const result = await runCommand("npm", ["run", "build"], tempDir);

    return {
      enabled: true,
      passed: result.code === 0,
      message: result.code === 0 ? "Build passed." : "Build failed.",
      output: `${result.stdout}\n${result.stderr}`.trim().slice(-16000),
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "shipit",
    version: "0.2.0",
    githubConfigured: Boolean(
      process.env.GITHUB_TOKEN &&
      process.env.GITHUB_OWNER &&
      process.env.GITHUB_REPO &&
      process.env.GITHUB_BRANCH
    ),
    vercelStatusConfigured: vercelConfigured(),
    buildCheckEnabled: RUN_BUILD_CHECK,
  });
});

app.get("/api/config", (_req, res) => {
  res.json({
    owner: process.env.GITHUB_OWNER || "",
    repo: process.env.GITHUB_REPO || "",
    branch: process.env.GITHUB_BRANCH || "main",
    maxUploadMb: MAX_UPLOAD_MB,
    buildCheckEnabled: RUN_BUILD_CHECK,
    vercelStatusConfigured: vercelConfigured(),
  });
});

app.get("/api/deployment", async (_req, res) => {
  try {
    const deployment = await findLatestVercelDeployment();
    res.json({ ok: true, configured: vercelConfigured(), deployment });
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      configured: vercelConfigured(),
      error: error.message,
    });
  }
});

app.post("/api/ship", upload.single("project"), async (req, res) => {
  try {
    requireGithubConfig();

    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Project ZIP is required." });
    }

    const owner = String(req.body.owner || process.env.GITHUB_OWNER).trim();
    const repo = String(req.body.repo || process.env.GITHUB_REPO).trim();
    const branch = String(req.body.branch || process.env.GITHUB_BRANCH).trim();
    const message =
      String(req.body.message || "Ship project with ShipIt").trim() ||
      "Ship project with ShipIt";

    if (!/^[A-Za-z0-9_.-]+$/.test(owner)) {
      return res.status(400).json({ ok: false, error: "Invalid GitHub owner." });
    }

    if (!/^[A-Za-z0-9_.-]+$/.test(repo)) {
      return res.status(400).json({ ok: false, error: "Invalid GitHub repository." });
    }

    if (!/^[A-Za-z0-9_.\\/-]+$/.test(branch)) {
      return res.status(400).json({ ok: false, error: "Invalid Git branch." });
    }

    const files = extractProject(req.file.buffer);
    const validation = validateProject(files);

    const build = await buildCheck(files, validation.packageJson);

    if (build.enabled && !build.passed) {
      return res.status(422).json({
        ok: false,
        stage: "build",
        error: build.message,
        project: {
          fileCount: files.length,
          warnings: validation.warnings,
        },
        build,
      });
    }

    const github = await shipToGithub({
      files,
      owner,
      repo,
      branch,
      message,
    });

    res.json({
      ok: true,
      requestId: crypto.randomUUID(),
      project: {
        fileCount: files.length,
        totalBytes: files.reduce((sum, f) => sum + f.size, 0),
        warnings: validation.warnings,
      },
      build,
      github,
      vercel: {
        statusConfigured: vercelConfigured(),
        message: "Vercel should deploy automatically if this GitHub repository is connected to a Vercel project.",
      },
    });
  } catch (error) {
    console.error(error);

    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : error.status || 500;

    res.status(status).json({
      ok: false,
      error:
        error.code === "LIMIT_FILE_SIZE"
          ? `Upload exceeds the ${MAX_UPLOAD_MB} MB limit.`
          : error.message || "Ship failed.",
    });
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: "Unexpected server error." });
});

app.listen(PORT, () => {
  console.log(`ShipIt v0.2 running at http://localhost:${PORT}`);
});
