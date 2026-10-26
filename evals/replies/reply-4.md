SQLite, unless you already know you need something Postgres does better.

For a small personal app, SQLite usually wins:

- **Zero setup.** It's a file. No server to install, run, back up separately, or keep alive.
- **Easy backups and portability.** Copy the file. Move it between machines. Check it into a private backup.
- **Plenty fast for one user.** Reads are very quick, and a single writer handles personal-scale traffic easily.
- **Lower cost and fewer moving parts.** No hosting bill for a database, no connection management.

Choose Postgres if any of these apply:

- Multiple services or processes write concurrently at real volume.
- You want to deploy to a platform where the app is stateless and the DB is managed separately (many PaaS setups make this natural, though SQLite on a persistent volume also works).
- You need features like robust full-text search at scale, JSON-heavy querying, or extensions such as PostGIS or pgvector.
- You expect to grow into multiple users with heavy concurrent writes.
- You want to learn or use the same database you'd use at work.

A practical note: if you start with SQLite, keep your SQL standard and use an ORM or query layer that supports both (Drizzle, Prisma, SQLAlchemy, Django ORM). Migrating later is then a modest job rather than a rewrite.

If you tell me what the app does and where it will run, I can give a more specific recommendation.
