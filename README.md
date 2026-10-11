# Bunny Empire Official Bot

A separate Discord bot for owner-controlled announcements, opt-in DM announcements, moderation, and security alerts.

## Environment variables

- `DISCORD_TOKEN` — bot token
- `CLIENT_ID` — Discord application ID
- `BUNNY_ID` — Bunny's Discord user ID; all slash commands are restricted to this ID
- `PORT` — optional health-check port (default `3000`)

## Setup

1. Use Node.js 20.10 or newer.
2. Install dependencies with `npm install`.
3. Copy `.env.example` to `.env` and fill in the three required IDs/token.
4. Enable **Server Members Intent** and **Guild Moderation intent** in the Discord Developer Portal if shown.
5. Invite the bot with `bot` and `applications.commands` scopes. Grant View Channels, Send Messages, View Audit Log, Manage Roles, Ban Members, Kick Members, and Moderate Members as needed.
6. Keep the bot's highest role above the staff role you configure for anti-nuke.
7. Run `npm start`.

## Commands (bot owner only)

- `/ann message` — opens a private destination panel: All Servers, This Server, All Users (opt-in), or Selected Users (opt-in).
- `/ann-channel channel` — configure the announcement channel for the current server.
- `/dm-panel channel` — post Subscribe / Unsubscribe buttons. Only subscribers receive DM announcements.
- `/ban user reason`, `/kick user reason`, `/timeout user minutes reason` — moderation.
- `/security-setup staff_role` — configure the staff role monitored for rapid/repeated kicks and bans.
- `/security-status` — view security settings.
- `/help` — command list.

## Safety and anti-nuke behaviour

DM announcements are sent only to users who explicitly subscribed through the public opt-in panel. Users can unsubscribe at any time. Selected-user DMs are also limited to subscribed users. A run is capped at 500 DM recipients.

The anti-nuke watcher observes Discord audit-log kick and ban events for members holding the configured staff role. One action is only reported. Two actions within 10 seconds, or three actions within 5 minutes, cause the configured staff role to be removed for one hour. If the actor continues while quarantined, Bunny receives another private alert. A ban requires Bunny to press **Confirm Ban** in the DM; the bot does not automatically ban a moderator based only on a burst heuristic.

Bot additions to any connected server and additions of other bots are reported to Bunny by DM. Security monitoring requires the bot to have View Audit Log and Manage Roles, and the configured role must be below the bot's highest role.

## Notes

- Set the bot's display name to **Bunny Empire Official Bot** in the Discord Developer Portal.
- Presence is set to **Playing POWERED BY BUNNY EMPIRE**.
- Data is stored in `data/bunny-empire.json`. Keep this folder persistent on your host.
- Global slash-command updates can take some time to appear in Discord.
- The health endpoint is `/health`.
