# Deploying CSI Workspace on Railway (real pilot)

The code lives on GitHub. Railway builds it from the repository and runs it, and it redeploys automatically whenever new code is pushed. The setup below is for a **real pilot**: the app starts empty, with demo data off, and one administrator account that you choose.

**Cost:** Railway Hobby plan, about US$5/month including usage for a small pilot, plus a little for the volume. Check railway.com/pricing for current prices.

## 1. Create the service

1. Sign in at **railway.com** with GitHub. Use the account that has access to `Ntando-Mahlangu/Nkosi-Intergration`.
2. **New Project → Deploy from GitHub repo →** choose `Nkosi-Intergration`. If Railway asks, allow it access to that repository.
3. Open the new service, then **Settings**:
   - **Source → Root Directory:** `csi-workspace`
   - **Source → Branch:** `main`. If the code hasn't been merged to `main` yet, choose `claude/clever-dirac-pl6rdt`.
   - **Config-as-code → Railway config file:** `/csi-workspace/railway.json`. This sets the Dockerfile build, the `/health` check, restart-on-failure and a single instance.

## 2. Add the permanent volume (required)

The database is a single file. Without a volume, **all data is lost on every redeploy**.

Right-click the service (or use the command palette), choose **Add Volume**, and set **Mount path** to `/data`.

## 3. Set variables

In the service, open **Variables → Raw Editor** and paste the block below. Replace the email and password with your own.

```
NODE_ENV=production
PORT=4000
DATABASE_PATH=/data/csi-workspace.db
SEED_DEMO_DATA=false
BOOTSTRAP_ADMIN_EMAIL=your.name@your-domain.org
BOOTSTRAP_ADMIN_PASSWORD=Choose-a-strong-temporary-password-1
```

**Optional:**
- `ANTHROPIC_API_KEY=...` turns on AI suggestions. Without it, the rule-based extractor is used.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_ALLOWED_DOMAIN` enable Google Workspace sign-in (see DEPLOYMENT.md).

Set `PORT=4000` explicitly so the app and the Railway domain agree on the port. When you generate the domain, set its **target port to 4000**. The public address is detected automatically.

## 4. Get a web address and deploy

1. **Settings → Networking → Generate Domain**, with target port **4000**. You'll get an address like `https://csi-workspace-production.up.railway.app`.
2. Railway builds and deploys, which takes about 3–5 minutes. **Deployments** shows progress. The log should end with `CSI Workspace API listening on port …` and `Created initial administrator …`.
3. Open the address and sign in with the bootstrap email and password. You'll be asked to choose a **new** password immediately.
4. Back in Railway, **delete the `BOOTSTRAP_ADMIN_PASSWORD` variable.** It is only used when the database is empty, but it shouldn't sit there.

## 5. Set up the pilot inside the app

As the administrator, go to **Administration**:

1. **Settings:** set the organisation name, timezone and currency.
2. **Roles:** review the five default roles.
3. **Teams**, then **Users.** Each new user gets a one-time temporary password to send them securely. They must change it at first sign-in.
4. **Taxonomies** and **Report templates:** adjust them to CSI's language.
5. Create the first real projects. You can also import existing task or project lists from CSV under **Administration → Data**.

## Custom domain (optional)

To use an address such as `workspace.changescience.org`:
1. In Railway, go to **Settings → Networking → Custom Domain** and add the domain.
2. Create the CNAME record Railway shows at your DNS provider.
3. Set the variable `PUBLIC_URL=https://workspace.changescience.org`.

## Backups

Railway volumes are not a backup. Regularly download a copy: **Administration → Data → Export** for CSV copies of records. For the full database file, use `railway volume` / `railway ssh` with the Railway CLI to copy `/data/csi-workspace.db`. Schedule this weekly, or daily once real work depends on it.

## Updating

Every push to the selected branch redeploys automatically. Data on the `/data` volume is kept. Database migrations run on start.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Deployment is Active but the site shows "Application failed to respond" | Port mismatch. Add the variable `PORT=4000` and make sure the domain's target port (Settings → Networking) is 4000. |
| Deploy fails at the health check | Open **Deployments → View logs**. Most often a variable is mistyped. |
| Data disappeared after a redeploy | The volume is missing or not mounted at `/data`. Add it (step 2). |
| Can't sign in with the bootstrap admin | The admin is only created when the database is empty. If you changed the email after the first deploy, sign in with the original one, or delete and re-create the volume (this erases data). |
| "Request blocked (missing CSRF header)" from a script | Expected: API calls must come from the app (or send the `x-csi-request: 1` header). |
