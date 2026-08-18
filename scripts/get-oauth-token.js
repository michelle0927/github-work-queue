import { createOAuthDeviceAuth } from "@octokit/auth-oauth-device";

const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
if (!clientId) {
  console.error("Missing GITHUB_OAUTH_CLIENT_ID env var (your GitHub OAuth App's Client ID).");
  process.exit(1);
}

const auth = createOAuthDeviceAuth({
  clientType: "oauth-app",
  clientId,
  scopes: ["repo", "read:project"],
  onVerification(verification) {
    console.log(`First, visit: ${verification.verification_uri}`);
    console.log(`Enter code: ${verification.user_code}`);
    console.log("\nWaiting for authorization...");
  },
});

const { token } = await auth({ type: "oauth" });

console.log("\n✓ Authorized!");
console.log(`Access token: ${token}`);
console.log("\nAdd this as GITHUB_OAUTH_TOKEN in your Vercel project env vars.");
