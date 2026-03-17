import { DefineOAuth2Provider, Schema } from "deno-slack-sdk/mod.ts";

/**
 * Google OAuth2 provider for accessing Google Sheets.
 *
 * You will need to create an OAuth2 Client ID in Google Cloud Console:
 *   1. Go to https://console.cloud.google.com → APIs & Services → Credentials
 *   2. Click "+ CREATE CREDENTIALS" → "OAuth client ID"
 *   3. Application type: "Web application"
 *   4. Add authorized redirect URI: https://oauth2.slack.com/external/auth/callback
 *   5. Copy the Client ID and Client Secret
 *
 * Then after deploying, add the secret via CLI:
 *   slack external-auth add-secret --provider google --secret YOUR_CLIENT_SECRET
 */
const GoogleProvider = DefineOAuth2Provider({
  provider_key: "google",
  provider_type: Schema.providers.oauth2.CUSTOM,
  options: {
    provider_name: "Google",
    authorization_url: "https://accounts.google.com/o/oauth2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    client_id: "724902613772-5udb85ped6c3l38un9h8a778fks3sto5.apps.googleusercontent.com",
    scope: [
      "https://www.googleapis.com/auth/spreadsheets.readonly",
    ],
    authorization_url_extras: {
      prompt: "consent",
      access_type: "offline",
    },
    identity_config: {
      url: "https://www.googleapis.com/oauth2/v1/userinfo",
      account_identifier: "$.email",
    },
  },
});

export default GoogleProvider;
