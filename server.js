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
const SHIPIT_VERSION = '4.0.0';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

class ApiError extends Error {
  constructor(message, status, service, endpoint, details) {
    super(message); this.name='ApiError'; this.status=status; this.service=service;
    this.endpoint=endpoint; this.details=details || '';
  }
}

function requireGithubToken() {
  if (!process.env.GITHUB_TOKEN) {
    const e = new Error('GITHUB_TOKEN is not configured in the server environment.');
    e.code='MISSING_GITHUB_TOKEN'; throw e;
  }
}

function githubHeaders(extra={}) {
  return {
    Accept:'application/vnd.github+json',
    Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,
    'X-GitHub-Api-Version':GITHUB_API_VERSION,
    'User-Agent':'ShipIt/4.0.0', ...extra
  };
}

async function github(endpoint, options={}) {
  requireGithubToken();
  const response=await fetch(`${GITHUB_API}${endpoint}`, {...options,headers:githubHeaders(options.headers||{})});
  const text=await response.text(); let data={};
  try { data=text?JSON.parse(text):{}; } catch { data={message:text}; }
  if(!response.ok) throw new ApiError(data.message||`GitHub API returned HTTP ${response.status}.`,response.status,'GitHub',endpoint,response.headers.get('x-accepted-github-permissions')||'');
  return data;
}

function githubPathSegment(v){ return encodeURIComponent(v); }
function repoPath(owner,repo){ return `/repos/${githubPathSegment(owner)}/${githubPathSegment(repo)}`; }
async function githubUser(){ return github('/user'); }

function safeZipPath(value){
  const normalized=String(value).replaceAll('\\','/').replace(/^\/+/,'');
  const parts=normalized.split('/').filter(Boolean);
  if(!parts.length || parts.includes('..') || parts.some(p=>p==='.') || normalized.includes('\0')) throw new Error(`Unsafe ZIP path: ${value}`);
  return parts.join('/');
}
function shouldSkip(filePath){
  const lower=filePath.toLowerCase(); const base=lower.split('/').pop();
  return lower==='.env'||lower.startsWith('.env.')||lower==='.git'||lower.startsWith('.git/')||lower==='node_modules'||lower.startsWith('node_modules/')||lower==='.vercel'||lower.startsWith('.vercel/')||lower.startsWith('.next/')||lower.startsWith('dist/')||lower.startsWith('build/')||['.ds_store','thumbs.db','npm-debug.log','yarn-error.log','pnpm-debug.log'].includes(base);
}
function stripCommonRoot(files){
  if(files.some(f=>f.path==='package.json')) return files;
  const roots=new Set(files.map(f=>f.path.split('/')[0])); if(roots.size!==1) return files;
  const root=[...roots][0], prefix=`${root}/`;
  const nested=files.map(f=>({...f,path:f.path.startsWith(prefix)?f.path.slice(prefix.length):f.path}));
  return nested.some(f=>f.path==='package.json')?nested:files;
}
function extractZip(buffer){
  const zip=new AdmZip(buffer); const entries=zip.getEntries(); if(!entries.length) throw new Error('The ZIP file is empty.');
  const files=[];
  for(const entry of entries){
    if(entry.isDirectory) continue;
    const filePath=safeZipPath(entry.entryName); if(shouldSkip(filePath)) continue;
    const content=entry.getData();
    if(content.length>MAX_FILE_SIZE_MB*1024*1024) throw new Error(`File "${filePath}" exceeds ${MAX_FILE_SIZE_MB} MB.`);
    files.push({path:filePath,content,size:content.length});
    if(files.length>MAX_FILES) throw new Error(`Project contains more than ${MAX_FILES} files.`);
  }
  if(!files.length) throw new Error('No deployable files were found.');
  return stripCommonRoot(files);
}
function validateName(value,label){ if(!value||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value)) throw new Error(`Invalid ${label}.`); }
function validateVercelName(value){
  if(!value||value.length>52||!/^([a-z0-9]+(?:-[a-z0-9]+)*)$/.test(value)) throw new Error('Invalid Vercel project name. Use lowercase letters, numbers and single hyphens, up to 52 characters.');
}
function validateBranch(value){ if(!value||value.length>250||value.startsWith('-')||value.includes(' ')||value.includes('..')||/[\u0000-\u001f~^:?*\\[\]]/.test(value)) throw new Error('Invalid Git branch name.'); }

async function getRepository(owner,repo){ return github(repoPath(owner,repo)); }
async function createRepository(repo,project){
  return github('/user/repos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:repo,description:`Managed by ShipIt · Vercel project: ${project}`,private:true,auto_init:true})});
}
async function createOrFailRepository(owner,repo,project){
  try { const existing=await getRepository(owner,repo); const e=new Error(`GitHub repository "${repo}" already exists. Choose a different repository name.`); e.code='REPOSITORY_EXISTS'; e.status=409; e.repositoryUrl=existing.html_url; throw e; }
  catch(error){ if(error.code==='REPOSITORY_EXISTS') throw error; if(!(error instanceof ApiError)||error.status!==404) throw error; }
  try { return await createRepository(repo,project); }
  catch(error){
    if(error instanceof ApiError && error.service==='GitHub'){
      if(error.status===404){ const e=new Error('GitHub returned 404 while creating the repository. The credential can authenticate, but it may not have repository-creation permission.'); e.code='GITHUB_REPO_CREATE_PERMISSION'; e.status=403; e.github=error; throw e; }
      if(error.status===403){ const e=new Error('GitHub denied repository creation. Give the credential permission to create repositories, then redeploy ShipIt.'); e.code='GITHUB_REPO_CREATE_PERMISSION'; e.status=403; e.github=error; throw e; }
    }
    throw error;
  }
}
async function getBranchRef(owner,repo,branch){ return github(`${repoPath(owner,repo)}/git/ref/heads/${githubPathSegment(branch)}`); }
async function ensureBranch(owner,repo,branch){
  try { return await getBranchRef(owner,repo,branch); }
  catch(error){
    if(!(error instanceof ApiError)||error.status!==404) throw error;
    const repository=await getRepository(owner,repo); const defaultBranch=repository.default_branch; const source=await getBranchRef(owner,repo,defaultBranch);
    if(branch===defaultBranch) throw error;
    return github(`${repoPath(owner,repo)}/git/refs`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ref:`refs/heads/${branch}`,sha:source.object.sha})});
  }
}
async function shipGithubFiles({files,owner,repo,branch,message}){
  const branchRef=await ensureBranch(owner,repo,branch); const parentSha=branchRef.object.sha; const parentCommit=await github(`${repoPath(owner,repo)}/git/commits/${parentSha}`);
  const blobs=[];
  for(const file of files) blobs.push(await github(`${repoPath(owner,repo)}/git/blobs`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:file.content.toString('base64'),encoding:'base64'})}));
  const tree=await github(`${repoPath(owner,repo)}/git/trees`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({base_tree:parentCommit.tree.sha,tree:files.map((file,i)=>({path:file.path,mode:'100644',type:'blob',sha:blobs[i].sha}))})});
  const commit=await github(`${repoPath(owner,repo)}/git/commits`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message,tree:tree.sha,parents:[parentSha]})});
  await github(`${repoPath(owner,repo)}/git/refs/heads/${githubPathSegment(branch)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({sha:commit.sha,force:false})});
  return {commitSha:commit.sha,commitUrl:commit.html_url,branch,repositoryUrl:`https://github.com/${owner}/${repo}`};
}
function validateProject(files){
  const packageFile=files.find(f=>f.path==='package.json'); const warnings=[]; if(!packageFile){warnings.push('No package.json found at the project root.');return warnings;}
  try { const pkg=JSON.parse(packageFile.content.toString('utf8')); if(!pkg.scripts?.build) warnings.push('package.json has no build script; Vercel may use framework defaults or deploy a static project.'); }
  catch { throw new Error('package.json is not valid JSON.'); }
  return warnings;
}

// --- Vercel OAuth: public client (client authentication method "none") ---
// The Vercel App Client ID is not a secret. ShipIt stores it in an HttpOnly cookie during OAuth.
function cookieFlags(){ return {httpOnly:true,secure:true,sameSite:'lax',path:'/'}; }
function randomToken(bytes=32){ return crypto.randomBytes(bytes).toString('base64url'); }
function pkceChallenge(verifier){ return crypto.createHash('sha256').update(verifier).digest('base64url'); }
function parseCookies(header=''){
  const out={}; for(const part of header.split(';')){ const i=part.indexOf('='); if(i<0) continue; out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim()); } return out;
}
function setCookie(res,name,value,opts={}){
  const parts=[`${name}=${encodeURIComponent(value)}`,'Path=/','HttpOnly','Secure','SameSite=Lax']; if(opts.maxAge!==undefined) parts.push(`Max-Age=${opts.maxAge}`); res.append('Set-Cookie',parts.join('; '));
}
function clearCookie(res,name){ setCookie(res,name,'',{maxAge:0}); }
function oauthCookie(res,name,value,maxAge=600){ setCookie(res,name,value,{maxAge}); }

async function vercelApi(accessToken,endpoint,options={}){
  const response=await fetch(`${VERCEL_API}${endpoint}`,{...options,headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json',...(options.headers||{})}});
  const text=await response.text(); let data={}; try{data=text?JSON.parse(text):{};}catch{data={message:text};}
  if(!response.ok) throw new ApiError(data?.error?.message||data?.message||`Vercel API returned HTTP ${response.status}.`,response.status,'Vercel',endpoint,JSON.stringify(data?.error||data));
  return data;
}
async function vercelUser(accessToken){ return vercelApi(accessToken,'/v2/user'); }
async function refreshVercelAccess(req,res){
  const cookies=parseCookies(req.headers.cookie||''); const refresh=cookies.shipit_v_refresh; const clientId=cookies.shipit_v_client;
  if(!refresh||!clientId) return null;
  const body=new URLSearchParams({grant_type:'refresh_token',refresh_token:refresh,client_id:clientId});
  const response=await fetch('https://api.vercel.com/login/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
  if(!response.ok){ clearCookie(res,'shipit_v_access'); clearCookie(res,'shipit_v_refresh'); return null; }
  const data=await response.json(); oauthCookie(res,'shipit_v_access',data.access_token,Math.max(60,(data.expires_in||3600)-60)); if(data.refresh_token) oauthCookie(res,'shipit_v_refresh',data.refresh_token,60*60*24*30); return data.access_token;
}
async function getVercelAccess(req,res){
  const cookies=parseCookies(req.headers.cookie||''); if(cookies.shipit_v_access) return cookies.shipit_v_access; return refreshVercelAccess(req,res);
}

app.get('/api/vercel/authorize',(req,res)=>{
  const clientId=String(req.query.clientId||'').trim(); if(!/^cl_[A-Za-z0-9_-]+$/.test(clientId)) return res.status(400).send('Invalid Vercel App Client ID.');
  const state=randomToken(32),nonce=randomToken(32),verifier=randomToken(48); const redirectUri=`${req.protocol}://${req.get('host')}/api/vercel/callback`;
  oauthCookie(res,'shipit_v_state',state); oauthCookie(res,'shipit_v_nonce',nonce); oauthCookie(res,'shipit_v_verifier',verifier); oauthCookie(res,'shipit_v_client',clientId,60*60*24*30);
  const q=new URLSearchParams({client_id:clientId,response_type:'code',redirect_uri:redirectUri,state,nonce,code_challenge:pkceChallenge(verifier),code_challenge_method:'S256',scope:'openid profile offline_access'});
  res.redirect(`https://vercel.com/oauth/authorize?${q}`);
});
app.get('/api/vercel/callback',async(req,res)=>{
  try{
    const cookies=parseCookies(req.headers.cookie||''); const {code,state}=req.query; if(!code) throw new Error(String(req.query.error_description||'Vercel authorization was cancelled.'));
    if(!state||state!==cookies.shipit_v_state) throw new Error('Vercel OAuth state validation failed. Please try Connect Vercel again.');
    const clientId=cookies.shipit_v_client,verifier=cookies.shipit_v_verifier; if(!clientId||!verifier) throw new Error('Vercel OAuth session expired. Please connect again.');
    const redirectUri=`${req.protocol}://${req.get('host')}/api/vercel/callback`;
    const body=new URLSearchParams({grant_type:'authorization_code',client_id:clientId,code:String(code),code_verifier:verifier,redirect_uri:redirectUri});
    const tokenResponse=await fetch('https://api.vercel.com/login/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
    const tokenText=await tokenResponse.text(); let tokenData={}; try{tokenData=tokenText?JSON.parse(tokenText):{};}catch{}
    if(!tokenResponse.ok) throw new Error(tokenData?.error_description||tokenData?.error?.message||'Vercel token exchange failed.');
    oauthCookie(res,'shipit_v_access',tokenData.access_token,Math.max(60,(tokenData.expires_in||3600)-60)); if(tokenData.refresh_token) oauthCookie(res,'shipit_v_refresh',tokenData.refresh_token,60*60*24*30);
    clearCookie(res,'shipit_v_state'); clearCookie(res,'shipit_v_nonce'); clearCookie(res,'shipit_v_verifier');
    res.redirect('/?vercel=connected');
  }catch(error){ res.redirect(`/?vercel=error&message=${encodeURIComponent(error.message||'Vercel authorization failed.')}`); }
});
app.post('/api/vercel/disconnect',async(req,res)=>{ const cookies=parseCookies(req.headers.cookie||''); if(cookies.shipit_v_access){try{await fetch('https://api.vercel.com/login/oauth/token/revoke',{method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${cookies.shipit_v_client}:`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:cookies.shipit_v_access})});}catch{}} clearCookie(res,'shipit_v_access');clearCookie(res,'shipit_v_refresh');clearCookie(res,'shipit_v_client');res.json({ok:true}); });
app.get('/api/vercel/status',async(req,res)=>{ try{const token=await getVercelAccess(req,res); if(!token) return res.json({ok:true,connected:false}); const user=await vercelUser(token); res.json({ok:true,connected:true,user:{id:user.id,username:user.username,name:user.name}});}catch(error){res.status(error.status||500).json({ok:false,error:error.message,service:error.service});} });

async function ensureVercelProject(token,name){
  try{return await vercelApi(token,`/v9/projects/${encodeURIComponent(name)}`);}
  catch(error){ if(!(error instanceof ApiError)||error.status!==404) throw error; }
  return vercelApi(token,'/v11/projects',{method:'POST',body:JSON.stringify({name})});
}
async function uploadVercelFile(token,file){
  const sha=crypto.createHash('sha1').update(file.content).digest('hex');
  const response=await fetch(`${VERCEL_API}/v2/now/files`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/octet-stream','x-vercel-digest':sha,'Content-Length':String(file.content.length)},body:file.content});
  if(!response.ok){const text=await response.text();let data={};try{data=JSON.parse(text)}catch{data={message:text}}throw new ApiError(data?.error?.message||data?.message||`Vercel file upload failed with HTTP ${response.status}.`,response.status,'Vercel','/v2/now/files',JSON.stringify(data));}
  return {sha,size:file.content.length};
}
async function deployVercel(token,{project,name,files}){
  const uploaded=[];
  for(const file of files) uploaded.push({...await uploadVercelFile(token,file),file:file.path});
  const deployment=await vercelApi(token,'/v13/deployments',{method:'POST',body:JSON.stringify({name,project:project.id,target:'production',files:uploaded.map(x=>({file:x.file,sha:x.sha,size:x.size})),projectSettings:{framework:null}})});
  return deployment;
}
async function waitForVercel(token,deploymentId,maxMs=120000){
  const started=Date.now(); let last=null;
  while(Date.now()-started<maxMs){
    last=await vercelApi(token,`/v13/deployments/${encodeURIComponent(deploymentId)}`);
    const state=last.readyState||last.state;
    if(state==='READY') return last;
    if(['ERROR','CANCELED'].includes(state)) return last;
    await new Promise(r=>setTimeout(r,3000));
  }
  return last||{};
}
function publicApiError(error){ const out={error:error.message||'Request failed.'}; if(error.code)out.code=error.code; if(error.service)out.service=error.service; if(error.endpoint)out.endpoint=error.endpoint; if(error.status)out.status=error.status; if(error.details)out.details=error.details; if(error.github instanceof ApiError)out.github={status:error.github.status,endpoint:error.github.endpoint,message:error.github.message,acceptedPermissions:error.github.details||undefined}; return out; }

app.get('/api/health',async(req,res)=>{try{requireGithubToken();const u=await githubUser();const v=await getVercelAccess(req,res);let vu=null;if(v){try{vu=await vercelUser(v)}catch{vu=null;}}res.json({ok:true,version:SHIPIT_VERSION,githubAccount:u.login,vercelConnected:!!vu,vercelUser:vu?{username:vu.username,name:vu.name}:null,requiredEnvironmentVariables:['GITHUB_TOKEN']});}catch(error){res.status(error.status||500).json({ok:false,...publicApiError(error),requiredEnvironmentVariables:['GITHUB_TOKEN']});}});

app.post('/api/ship',upload.single('project'),async(req,res)=>{
  const requestId=crypto.randomUUID();
  try{
    requireGithubToken(); if(!req.file) throw new Error('Project ZIP is required.');
    const repo=String(req.body.repositoryName||'').trim(),branch=String(req.body.branch||'main').trim(),project=String(req.body.projectName||'').trim(),message=String(req.body.message||`Ship ${project||repo} with ShipIt`).trim();
    validateName(repo,'repository name'); validateVercelName(project); validateBranch(branch);
    const githubAccount=await githubUser(); const files=extractZip(req.file.buffer); const warnings=validateProject(files);
    const repository=await createOrFailRepository(githubAccount.login,repo,project); const ghResult=await shipGithubFiles({files,owner:githubAccount.login,repo,branch,message});
    const vToken=await getVercelAccess(req,res); if(!vToken){
      return res.status(428).json({ok:false,requestId,code:'VERCEL_NOT_CONNECTED',error:'GitHub project shipped, but Vercel is not connected. Click Connect Vercel and authorize ShipIt, then retry deployment.',github:{...ghResult,created:true,repositoryId:repository.id},project:{fileCount:files.length,totalBytes:files.reduce((s,f)=>s+f.size,0),warnings}});
    }
    const vUser=await vercelUser(vToken); const vProject=await ensureVercelProject(vToken,project); const deployment=await deployVercel(vToken,{project:vProject,name:project,files}); const final=await waitForVercel(vToken,deployment.id,120000);
    const state=final.readyState||final.state||deployment.readyState||deployment.state||'INITIALIZING';
    const liveUrl=final.alias?.[0]?`https://${final.alias[0]}`:(final.url?`https://${final.url}`:(deployment.url?`https://${deployment.url}`:null));
    res.json({ok:true,requestId,githubAccount:githubAccount.login,projectName:project,project:{fileCount:files.length,totalBytes:files.reduce((s,f)=>s+f.size,0),warnings},github:{...ghResult,created:true,repositoryId:repository.id},vercel:{connected:true,user:{username:vUser.username,name:vUser.name},projectId:vProject.id,projectUrl:`https://vercel.com/${vUser.username}/${project}`,deploymentId:deployment.id,state,url:liveUrl,deploymentUrl:deployment.url?`https://${deployment.url}`:null,inspectorUrl:final.inspectorUrl||deployment.inspectorUrl||null,message:state==='READY'?'Deployment is live.':`Deployment finished with state ${state}.`}});
  }catch(error){console.error(`[${requestId}]`,error);const status=error.code==='LIMIT_FILE_SIZE'?413:(error.status||500);const body=error.code==='LIMIT_FILE_SIZE'?{ok:false,requestId,error:`Upload exceeds ${MAX_UPLOAD_MB} MB.`,code:'UPLOAD_TOO_LARGE'}:{ok:false,requestId,...publicApiError(error)};res.status(status).json(body);}
});

app.get('/api/deployment-status',async(req,res)=>{try{const token=await getVercelAccess(req,res);if(!token)return res.status(401).json({ok:false,error:'Vercel is not connected.'});const id=String(req.query.id||'').trim();if(!id)throw new Error('Deployment ID is required.');const d=await vercelApi(token,`/v13/deployments/${encodeURIComponent(id)}`);const state=d.readyState||d.state;const url=d.alias?.[0]?`https://${d.alias[0]}`:(d.url?`https://${d.url}`:null);res.json({ok:true,state,url,deploymentUrl:d.url?`https://${d.url}`:null,inspectorUrl:d.inspectorUrl||null});}catch(error){res.status(error.status||500).json({ok:false,...publicApiError(error)});}});

app.use((req,res)=>{if(req.path.startsWith('/api/'))return res.status(404).json({ok:false,error:'API route not found.'});res.status(404).send('Not Found');});
app.listen(PORT,()=>console.log(`ShipIt v${SHIPIT_VERSION} running on port ${PORT}`));
