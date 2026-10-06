# ShipIt v4.0.0

**ZIP → GitHub repository → Vercel project → production deployment → live URL**

## What v4 changes

- Keeps **only `GITHUB_TOKEN`** as a server environment variable.
- Adds Vercel OAuth using a Vercel App configured with client authentication method **`none`**. No Vercel secret is stored in ShipIt's environment variables.
- Vercel access/refresh tokens are stored only in `HttpOnly`, `Secure`, `SameSite=Lax` cookies.
- Creates the GitHub repository and pushes the selected branch.
- Creates/reuses the requested Vercel project.
- Uploads the exact project source to Vercel through the REST API, so a GitHub-to-Vercel connection is not required for the first deployment.
- Creates a **production** deployment and waits for it to become `READY` (up to two minutes).
- Returns the live deployment URL, Vercel project URL, deployment URL and deployment details URL.
- Keeps wrapper-folder detection and ZIP safety checks from v0.3.x.

Vercel documents REST API deployments as a supported deployment method, including uploading files and then creating a deployment. See Vercel's deployment documentation and API reference.

## One-time Vercel setup

1. In your Vercel account/team, open **Settings → Apps → Create**.
2. Create an App for ShipIt.
3. Choose client authentication method **`none`**. Vercel documents this as suitable for public clients such as SPAs, mobile apps and CLIs.
4. Configure an Authorization Callback URL:

   `https://YOUR-SHIPIT-DOMAIN/api/vercel/callback`

   For local development:

   `http://localhost:3000/api/vercel/callback`

5. Configure the App permissions required for project creation and deployment. Your Vercel account/team must itself be allowed to create projects and deploy to production.
6. Copy the App's **Client ID** (starts with `cl_`).
7. Open ShipIt, paste the Client ID and tap **Connect Vercel**.
8. Approve the Vercel consent screen.

The Client ID is not a secret and is stored in browser local storage only to make reconnecting easier. The OAuth access and refresh tokens remain server-side in HttpOnly cookies.

## Environment

The only server environment variable is:

```env
GITHUB_TOKEN=github_pat_...
```

The GitHub credential must be capable of creating private repositories for the authenticated account.

## Deployment flow

```text
Phone
  ↓
ShipIt
  ├── GitHub: create repo → commit project
  └── Vercel OAuth → create project → upload source → production deploy
                                      ↓
                                  READY
                                      ↓
                              🌐 live URL
```

The Vercel deployment is source-based rather than relying on a GitHub deployment webhook. This means the first deployment does not require manually importing the GitHub repository into Vercel.

## Notes

- Vercel project names should use lowercase letters, numbers and single hyphens and are limited to 52 characters in ShipIt.
- ShipIt strips a single ZIP wrapper folder when `package.json` is inside that folder.
- `.env*`, `.git`, `node_modules`, `.vercel`, `.next`, `dist`, `build` and common OS/log files are excluded.
- Maximum ZIP size: 25 MB.
- Maximum files: 500.

## Run locally

```bash
npm install
cp .env.example .env
# set GITHUB_TOKEN
npm start
```

Then open `http://localhost:3000` and configure the Vercel callback URL as shown above.
