require('dotenv').config();
const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = 3000;
const MAX_UPLOAD_MB = 25;
const MAX_FILES = 500;
const MAX_FILE_SIZE_MB = 5;
const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const VERCEL_API = 'https://api.vercel.com';
const SHIPIT_VERSION = '5.0.0';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

class ApiError extends Error {
  constructor(message, status, service, endpoint, details = '') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.service = service;
    this.endpoint = endpoint;
    this.details = details;
  }
}

function requireEnv(name) {
  if (!process.env[name]) {
    const e = new Error(`${name} is not configured in the server environment.`);
    e.code = `MISSING_${name}`;
    throw e;
  }
}

function githubHeaders(extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': 'ShipIt/4.1.0',
    ...extra
  };
}

async function github(endpoint, options = {}) {
  requireEnv('GITHUB_TOKEN');
  const response = await fetch(`${GITHUB_API}${endpoint}`, {
    ...options,
    headers: githubHeaders(options.headers || {})
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!response.ok) {
    throw new ApiError(
      data.message || `GitHub API returned HTTP ${response.status}.`,
      response.status,
      'GitHub',
      endpoint,
      response.headers.get('x-accepted-github-permissions') || ''
    );
  }
  return data;
}

function githubPathSegment(value) { return encodeURIComponent(value); }
function repoPath(owner, repo) {
  return `/repos/${githubPathSegment(owner)}/${githubPathSegment(repo)}`;
}
async function githubUser() { return github('/user'); }

function safeZipPath(value) {
  const normalized = String(value).replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || parts.includes('..') || parts.some(p => p === '.') || normalized.includes('\0')) {
    throw new Error(`Unsafe ZIP path: ${value}`);
  }
  return parts.join('/');
}

function shouldSkip(filePath) {
  const lower = filePath.toLowerCase();
  const base = lower.split('/').pop();
  return lower === '.env' || lower.startsWith('.env.') ||
    lower === '.git' || lower.startsWith('.git/') ||
    lower === 'node_modules' || lower.startsWith('node_modules/') ||
    lower === '.vercel' || lower.startsWith('.vercel/') ||
    lower.startsWith('.next/') || lower.startsWith('dist/') || lower.startsWith('build/') ||
    ['.ds_store', 'thumbs.db', 'npm-debug.log', 'yarn-error.log', 'pnpm-debug.log'].includes(base);
}

function stripCommonRoot(files) {
  if (files.some(f => f.path === 'package.json')) return files;
  const roots = new Set(files.map(f => f.path.split('/')[0]));
  if (roots.size !== 1) return files;
  const root = [...roots][0];
  const prefix = `${root}/`;
  const nested = files.map(f => ({ ...f, path: f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path }));
  return nested.some(f => f.path === 'package.json') ? nested : files;
}

function extractZip(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  if (!entries.length) throw new Error('The ZIP file is empty.');

  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const filePath = safeZipPath(entry.entryName);
    if (shouldSkip(filePath)) continue;
    const content = entry.getData();
    if (content.length > MAX_FILE_SIZE_MB * 1024 * 1024) {
      throw new Error(`File "${filePath}" exceeds ${MAX_FILE_SIZE_MB} MB.`);
    }
    files.push({ path: filePath, content, size: content.length });
    if (files.length > MAX_FILES) throw new Error(`Project contains more than ${MAX_FILES} files.`);
  }
  if (!files.length) throw new Error('No deployable files were found.');
  return stripCommonRoot(files);
}

function validateName(value, label) {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value)) throw new Error(`Invalid ${label}.`);
}

function normalizeVercelName(value) {
  let name = String(value || '').trim().toLowerCase();
  name = name.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  if (!name) throw new Error('Invalid Vercel project name.');
  if (name.length > 52) name = name.slice(0, 52).replace(/-+$/, '');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('Invalid Vercel project name.');
  return name;
}

function validateBranch(value) {
  if (!value || value.length > 250 || value.startsWith('-') || value.includes(' ') || value.includes('..') || /[\u0000-\u001f~^:?*\\[\]]/.test(value)) {
    throw new Error('Invalid Git branch name.');
  }
}

async function getRepository(owner, repo) { return github(repoPath(owner, repo)); }

async function createRepository(repo, project) {
  return github('/user/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: repo,
      description: `Managed by ShipIt · Vercel project: ${project}`,
      private: true,
      auto_init: true
    })
  });
}

async function createOrFailRepository(owner, repo, project) {
  try {
    const existing = await getRepository(owner, repo);
    const e = new Error(`GitHub repository "${repo}" already exists. Choose a different repository name.`);
    e.code = 'REPOSITORY_EXISTS';
    e.status = 409;
    e.repositoryUrl = existing.html_url;
    throw e;
  } catch (error) {
    if (error.code === 'REPOSITORY_EXISTS') throw error;
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
  }

  try {
    return await createRepository(repo, project);
  } catch (error) {
    if (error instanceof ApiError && error.service === 'GitHub') {
      if (error.status === 404 || error.status === 403) {
        const e = new Error('GitHub denied repository creation. Your GITHUB_TOKEN must be allowed to create repositories for this account.');
        e.code = 'GITHUB_REPO_CREATE_PERMISSION';
        e.status = error.status;
        e.github = error;
        throw e;
      }
    }
    throw error;
  }
}

async function getBranchRef(owner, repo, branch) {
  return github(`${repoPath(owner, repo)}/git/ref/heads/${githubPathSegment(branch)}`);
}

async function ensureBranch(owner, repo, branch) {
  try {
    return await getBranchRef(owner, repo, branch);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    const repository = await getRepository(owner, repo);
    const defaultBranch = repository.default_branch;
    const source = await getBranchRef(owner, repo, defaultBranch);
    if (branch === defaultBranch) throw error;
    return github(`${repoPath(owner, repo)}/git/refs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: source.object.sha })
    });
  }
}

async function shipGithubFiles({ files, owner, repo, branch, message }) {
  const branchRef = await ensureBranch(owner, repo, branch);
  const parentSha = branchRef.object.sha;
  const parentCommit = await github(`${repoPath(owner, repo)}/git/commits/${parentSha}`);

  const blobs = [];
  for (const file of files) {
    blobs.push(await github(`${repoPath(owner, repo)}/git/blobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: file.content.toString('base64'), encoding: 'base64' })
    }));
  }

  const tree = await github(`${repoPath(owner, repo)}/git/trees`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_tree: parentCommit.tree.sha,
      tree: files.map((file, i) => ({ path: file.path, mode: '100644', type: 'blob', sha: blobs[i].sha }))
    })
  });

  const commit = await github(`${repoPath(owner, repo)}/git/commits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, tree: tree.sha, parents: [parentSha] })
  });

  await github(`${repoPath(owner, repo)}/git/refs/heads/${githubPathSegment(branch)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: commit.sha, force: false })
  });

  return {
    commitSha: commit.sha,
    commitUrl: commit.html_url,
    branch,
    repositoryUrl: `https://github.com/${owner}/${repo}`
  };
}

function validateProject(files) {
  const packageFile = files.find(f => f.path === 'package.json');
  const warnings = [];
  if (!packageFile) {
    warnings.push('No package.json found at the project root.');
    return warnings;
  }
  try {
    const pkg = JSON.parse(packageFile.content.toString('utf8'));
    if (!pkg.scripts?.build) warnings.push('package.json has no build script; Vercel may use framework defaults or deploy a static project.');
  } catch {
    throw new Error('package.json is not valid JSON.');
  }
  return warnings;
}

// ---------------- Vercel API ----------------

function vercelHeaders(extra = {}) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${process.env.SHIPIT_VERCEL_TOKEN}`,
    ...extra
  };
}

async function vercelApi(endpoint, options = {}) {
  requireEnv('SHIPIT_VERCEL_TOKEN');
  const response = await fetch(`${VERCEL_API}${endpoint}`, {
    ...options,
    headers: vercelHeaders(options.headers || {})
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || `Vercel API returned HTTP ${response.status}.`;
    throw new ApiError(message, response.status, 'Vercel', endpoint, data?.error?.code || '');
  }
  return data;
}

async function vercelUser() {
  return vercelApi('/v2/user');
}

async function getVercelProject(name) {
  return vercelApi(`/v9/projects/${encodeURIComponent(name)}`);
}

async function ensureVercelProject(name) {
  try {
    const existing = await getVercelProject(name);
    return { project: existing, created: false };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
  }

  const project = await vercelApi('/v11/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  return { project, created: true };
}

async function uploadVercelFile(file) {
  const digest = crypto.createHash('sha1').update(file.content).digest('hex');
  const endpoint = '/v2/files';
  const response = await fetch(`${VERCEL_API}${endpoint}`, {
    method: 'POST',
    headers: vercelHeaders({
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(file.content.length),
      'x-vercel-digest': digest
    }),
    body: file.content
  });
  const text = await response.text();
  if (!response.ok) {
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
    throw new ApiError(
      data?.error?.message || data?.message || `Vercel file upload returned HTTP ${response.status}.`,
      response.status,
      'Vercel',
      endpoint,
      data?.error?.code || ''
    );
  }
  return { file: file.path, sha: digest, size: file.content.length };
}

async function uploadAllVercelFiles(files) {
  const refs = [];
  for (const file of files) refs.push(await uploadVercelFile(file));
  return refs;
}

async function createDirectVercelDeployment({ projectId, projectName, files }) {
  const refs = await uploadAllVercelFiles(files);
  return vercelApi('/v13/deployments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: projectName,
      project: projectId,
      target: 'production',
      files: refs,
      projectSettings: {
        framework: null
      }
    })
  });
}

function deploymentState(deployment) {
  return deployment?.readyState || deployment?.state || 'QUEUED';
}

function deploymentUrl(deployment) {
  if (Array.isArray(deployment?.alias) && deployment.alias.length) {
    const production = deployment.alias.find(a => !String(a).includes('-git-')) || deployment.alias[0];
    return `https://${production}`;
  }
  if (deployment?.url) return String(deployment.url).startsWith('http') ? deployment.url : `https://${deployment.url}`;
  return null;
}

function deploymentInspectorUrl(deployment) {
  if (deployment?.inspectorUrl) return deployment.inspectorUrl;
  if (deployment?.id) return `https://vercel.com/${deployment.id}`;
  return null;
}

async function waitForDeployment(deploymentId, maxMs = 180000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < maxMs) {
    last = await vercelApi(`/v13/deployments/${encodeURIComponent(deploymentId)}`);
    const state = deploymentState(last);
    if (['READY', 'ERROR', 'CANCELED'].includes(state)) return last;
    await new Promise(resolve => setTimeout(resolve, 4000));
  }
  return last || {};
}

function publicApiError(error) {
  const out = { error: error.message || 'Request failed.' };
  if (error.code) out.code = error.code;
  if (error.service) out.service = error.service;
  if (error.endpoint) out.endpoint = error.endpoint;
  if (error.status) out.status = error.status;
  if (error.details) out.details = error.details;
  if (error.github instanceof ApiError) {
    out.github = {
      status: error.github.status,
      endpoint: error.github.endpoint,
      message: error.github.message,
      acceptedPermissions: error.github.details || undefined
    };
  }
  return out;
}

app.get('/api/health', async (req, res) => {
  const result = { ok: false, version: SHIPIT_VERSION, github: { connected: false }, vercel: { connected: false }, requiredEnvironmentVariables: ['GITHUB_TOKEN', 'SHIPIT_VERCEL_TOKEN'] };
  try {
    const gh = await githubUser();
    result.github = { connected: true, account: gh.login };
  } catch (error) {
    result.github = { connected: false, error: error.message };
  }
  try {
    const vc = await vercelUser();
    result.vercel = { connected: true, username: vc.username, name: vc.name };
  } catch (error) {
    result.vercel = { connected: false, error: error.message };
  }
  result.ok = result.github.connected && result.vercel.connected;
  res.status(result.ok ? 200 : 503).json(result);
});

app.post('/api/ship', upload.single('project'), async (req, res) => {
  const requestId = crypto.randomUUID();
  try {
    requireEnv('GITHUB_TOKEN');
    requireEnv('SHIPIT_VERCEL_TOKEN');
    if (!req.file) throw new Error('Project ZIP is required.');

    const repo = String(req.body.repositoryName || '').trim();
    const branch = String(req.body.branch || 'main').trim();
    const requestedProjectName = String(req.body.projectName || '').trim();
    const message = String(req.body.message || `Ship ${requestedProjectName || repo} with ShipIt`).trim();
    const projectName = normalizeVercelName(requestedProjectName);

    validateName(repo, 'repository name');
    validateBranch(branch);

    const githubAccount = await githubUser();
    const files = extractZip(req.file.buffer);
    const warnings = validateProject(files);
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

    // GitHub is the source-of-record copy.
    const repository = await createOrFailRepository(githubAccount.login, repo, projectName);
    const ghResult = await shipGithubFiles({ files, owner: githubAccount.login, repo, branch, message });

    // Vercel receives the same files directly. It does NOT need GitHub access.
    const vercelUserData = await vercelUser();
    const { project, created: vercelProjectCreated } = await ensureVercelProject(projectName);
    const deployment = await createDirectVercelDeployment({
      projectId: project.id,
      projectName,
      files
    });

    const final = await waitForDeployment(deployment.id);
    const state = deploymentState(final);
    const liveUrl = deploymentUrl(final) || deploymentUrl(deployment);
    const inspectorUrl = deploymentInspectorUrl(final) || deploymentInspectorUrl(deployment);
    const projectUrl = vercelUserData.username
      ? `https://vercel.com/${vercelUserData.username}/${projectName}`
      : `https://vercel.com/${projectName}`;

    res.json({
      ok: state === 'READY',
      requestId,
      githubAccount: githubAccount.login,
      projectName,
      project: { fileCount: files.length, totalBytes, warnings },
      github: { ...ghResult, created: true, repositoryId: repository.id },
      vercel: {
        connected: true,
        user: { username: vercelUserData.username, name: vercelUserData.name },
        projectId: project.id,
        projectCreated: vercelProjectCreated,
        projectUrl,
        deploymentId: deployment.id,
        state,
        url: liveUrl,
        deploymentUrl: deployment.url ? `https://${deployment.url}` : null,
        inspectorUrl,
        source: 'direct-files',
        message: state === 'READY'
          ? 'Production deployment is live.'
          : `Vercel deployment finished with state ${state}.`
      }
    });
  } catch (error) {
    console.error(`[${requestId}]`, error);
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : (error.status || 500);
    const body = error.code === 'LIMIT_FILE_SIZE'
      ? { ok: false, requestId, error: `Upload exceeds ${MAX_UPLOAD_MB} MB.`, code: 'UPLOAD_TOO_LARGE' }
      : { ok: false, requestId, ...publicApiError(error) };
    res.status(status).json(body);
  }
});

app.get('/api/deployment-status', async (req, res) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) throw new Error('Deployment ID is required.');
    const deployment = await vercelApi(`/v13/deployments/${encodeURIComponent(id)}`);
    res.json({
      ok: true,
      state: deploymentState(deployment),
      url: deploymentUrl(deployment),
      deploymentUrl: deployment.url ? `https://${deployment.url}` : null,
      inspectorUrl: deploymentInspectorUrl(deployment)
    });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, ...publicApiError(error) });
  }
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'API route not found.' });
  res.status(404).send('Not Found');
});

app.listen(PORT, () => console.log(`ShipIt v${SHIPIT_VERSION} running on port ${PORT}`));
