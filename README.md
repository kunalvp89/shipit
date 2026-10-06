# ShipIt v0.2

Mobile-first Node.js deployment gateway:

**ZIP -> validate -> optional build -> GitHub commit -> Vercel deployment**

## Security model

### GitHub

`GITHUB_TOKEN` is read exclusively from the **server/pipeline environment**.

It is:
- never requested from the browser
- never returned by an API
- never stored in the project database (there is no database in v0.2)
- never embedded in generated frontend code
- never accepted as an HTTP form field

Recommended GitHub fine-grained token permission:
- target repository only
- Contents: Read and write

GitHub's Git tree/commit/reference APIs support this workflow with Contents write permission.

### Vercel

ShipIt does not need a Vercel token for the primary workflow.

Recommended setup:
1. Connect the target GitHub repository to Vercel.
2. ShipIt pushes the commit.
3. Vercel's Git integration starts the deployment.

If you want ShipIt to query Vercel deployment status, set:
- `VERCEL_TOKEN`
- `VERCEL_PROJECT_ID`
- optional `VERCEL_TEAM_ID`

Those are also server-side environment variables. Never put them in `NEXT_PUBLIC_*` variables or frontend code.

## Local setup

```bash
npm install
cp .env.example .env
```

Set:

```env
GITHUB_TOKEN=github_pat_...
GITHUB_OWNER=your-user
GITHUB_REPO=shipit-test
GITHUB_BRANCH=main
```

Then:

```bash
npm start
```

Open:

http://localhost:3000

## CI/CD setup

For GitHub Actions, store `GITHUB_TOKEN` as a repository/org secret and inject it into the ShipIt process.

For another CI/CD system, inject the same variable into the runtime environment.

Example GitHub Actions:

```yaml
env:
  GITHUB_TOKEN: ${{ secrets.SHIPIT_GITHUB_TOKEN }}
  GITHUB_OWNER: ${{ vars.SHIPIT_GITHUB_OWNER }}
  GITHUB_REPO: ${{ vars.SHIPIT_GITHUB_REPO }}
  GITHUB_BRANCH: main
```

The application reads these with `process.env`.

## Vercel deployment

For the ShipIt application itself, add its environment variables in the Vercel project's Settings -> Environment Variables.

For Vercel secrets used by the application, use the Secret type. Do not use a public framework prefix such as `NEXT_PUBLIC_`.

Vercel project environment variables are only available to deployments after configuration and a redeploy.

## v0.2 features

- Mobile-first UI
- ZIP upload
- ZIP traversal protection
- secret/build artifact filtering
- project validation
- optional local build validation (`RUN_BUILD_CHECK=true`)
- GitHub Git Database API: blobs -> tree -> commit -> branch ref
- no client-side GitHub credential
- optional Vercel deployment lookup
- deployment status UI when Vercel variables are configured

## Optional build validation

Set:

```env
RUN_BUILD_CHECK=true
```

This runs a controlled local build in the ShipIt server's working directory.

For v0.2 it supports Node projects with a `package.json` and a `build` script.

Important: do not enable arbitrary command execution for untrusted public users. v0.2 is intended for a trusted/personal workflow.

## Recommended next version

```text
AI-generated ZIP
      |
      v
Secret scan
      |
      v
Install dependencies
      |
      v
Build/test
      |
   fail? ----> AI repair agent
      |
      v
Create shipit/<id> branch
      |
      v
GitHub commit / PR
      |
      v
Vercel Preview
      |
      v
Mobile approval
      |
      v
Production
```
