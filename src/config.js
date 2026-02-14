import "dotenv/config";

export const config = {
  botToken: process.env.BOT_TOKEN,
  groupId: process.env.GROUP_ID,
  sessionSecret: process.env.SESSION_SECRET,
  adminLogin: process.env.ADMIN_LOGIN,
  adminPassHash: process.env.ADMIN_PASS_HASH,
  webPort: process.env.WEB_PORT || 3000,
  db: {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 5432,
  },
};