import mysql, { type Pool } from 'mysql2/promise'

export interface MysqlConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
}

export function mysqlConfigFromEnv(): MysqlConfig | null {
  const database = process.env.MYSQL_DATABASE
  if (!database) return null
  return {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? 'root',
    password: process.env.MYSQL_PASSWORD ?? '',
    database,
  }
}

/** MySQL persistence for file metadata, sessions and (small) chunk manifests. */
export class MysqlDatabase {
  readonly pool: Pool

  constructor(readonly config: MysqlConfig) {
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      waitForConnections: true,
      connectionLimit: 8,
      charset: 'utf8mb4',
    })
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS parse_files (
        file_id VARCHAR(64) NOT NULL PRIMARY KEY,
        sha256 VARCHAR(64) NOT NULL,
        size BIGINT NOT NULL,
        format VARCHAR(16) NOT NULL,
        created_at VARCHAR(32) NOT NULL,
        KEY idx_parse_files_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS parse_sessions (
        id CHAR(36) NOT NULL PRIMARY KEY,
        file_id VARCHAR(64) NOT NULL,
        width INT NOT NULL,
        parser_version VARCHAR(64) NOT NULL,
        base_url TEXT NOT NULL,
        model JSON NOT NULL,
        fonts JSON NOT NULL,
        created_at BIGINT NOT NULL,
        last_used BIGINT NOT NULL,
        KEY idx_parse_sessions_file (file_id),
        KEY idx_parse_sessions_used (last_used)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS parse_chunk_manifests (
        session_id CHAR(36) NOT NULL PRIMARY KEY,
        file_id VARCHAR(64) NOT NULL,
        parser_version VARCHAR(64) NOT NULL,
        unit_count INT NOT NULL,
        chunk_blocks INT NOT NULL,
        manifest JSON NOT NULL,
        updated_at BIGINT NOT NULL,
        KEY idx_parse_chunks_file (file_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1')
      return true
    } catch {
      return false
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
