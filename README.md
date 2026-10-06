# ShipIt v0.3

**ZIP -> create GitHub repository -> push branch -> Vercel-ready deployment**

## Environment

ShipIt requires only:

```env
GITHUB_TOKEN=github_pat_...
```

The authenticated GitHub account is discovered with GitHub's `/user` API. The token is never accepted from or returned to the browser.

For automatic repository creation, the GitHub credential must have permission to create repositories under the authenticated account. For a fine-grained token, enable the repository administration permission required by the account/token policy, plus Contents read/write for Git operations.

## User inputs

The UI asks for:
- Project ZIP
- Vercel project/deployment name
- GitHub repository name
- Branch (defaults to `main`)
- Commit message

ShipIt creates the repository under the authenticated GitHub account, then pushes the project to the requested branch.

## Vercel

This version intentionally uses **no Vercel environment variable**. After the GitHub repository is created/pushed, Vercel should deploy it through your existing GitHub/Vercel integration. The requested project name is included in the repository description and returned as the deployment project name.

Programmatically creating a brand-new Vercel project requires Vercel authorization. The next version should use OAuth/GitHub/Vercel App authorization rather than introducing another long-lived environment secret.

## Run

```bash
npm install
cp .env.example .env
# put your token in .env
npm start
```

Open `http://localhost:3000`.
