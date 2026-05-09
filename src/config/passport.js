const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const pool = require("../db");

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "/auth/google/callback",
    },
    async (accessToken, refreshToken, profile, done) => {
      try {

        const email = profile.emails[0].value;

        let user = await pool.query(
          "SELECT * FROM users WHERE email=$1",
          [email]
        );

        if (user.rows.length === 0) {

          user = await pool.query(
            `
            INSERT INTO users
            (google_id, name, email, photo)
            VALUES ($1, $2, $3, $4)
            RETURNING *
            `,
            [
              profile.id,
              profile.displayName,
              email,
              profile.photos[0].value,
            ]
          );
        }

        return done(null, user.rows[0]);

      } catch (err) {
        return done(err, null);
      }
    }
  )
);