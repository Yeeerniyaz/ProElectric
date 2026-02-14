import 'dotenv/config';

export const config = {
    bot: {
        token: process.env.BOT_TOKEN,
        groupId: process.env.GROUP_ID,
        bossUsername: process.env.BOSS_USERNAME || '@yeeerniyaz'
    },
    db: {
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        port: parseInt(process.env.DB_PORT, 10) || 5432,
    },
    server: {
        port: process.env.WEB_PORT || 3000,
        sessionSecret: process.env.SESSION_SECRET || 'pro_electro_secret'
    }
};