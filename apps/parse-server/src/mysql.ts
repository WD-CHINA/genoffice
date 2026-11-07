import mysql, { type Pool } from 'mysql2/promise'

export interface MysqlConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
  socketPath?: string
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
    socketPath: process.env.MYSQL_SOCKET || undefined,
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
      socketPath: config.socketPath,
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
      CREATE TABLE IF NOT EXISTS library_entries (
        id CHAR(36) NOT NULL PRIMARY KEY,
        file_id VARCHAR(64) NOT NULL,
        display_name VARCHAR(255) NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        UNIQUE KEY uq_library_file (file_id),
        KEY idx_library_created (created_at, id),
        CONSTRAINT fk_library_file FOREIGN KEY (file_id) REFERENCES parse_files(file_id) ON DELETE RESTRICT
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
      CREATE TABLE IF NOT EXISTS parse_pending_sessions (
        id CHAR(36) NOT NULL PRIMARY KEY,
        file_id VARCHAR(64) NOT NULL,
        last_used BIGINT NOT NULL,
        record JSON NOT NULL,
        KEY idx_pending_file (file_id),
        KEY idx_pending_used (last_used),
        CONSTRAINT fk_pending_file FOREIGN KEY (file_id) REFERENCES parse_files(file_id) ON DELETE RESTRICT
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
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS parse_artifacts (
        artifact_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        file_id VARCHAR(64) NOT NULL,
        identity JSON NOT NULL,
        state VARCHAR(16) NOT NULL,
        generation BIGINT UNSIGNED NOT NULL DEFAULT 0,
        ready_generation BIGINT UNSIGNED NULL,
        storage_path VARCHAR(512) NULL,
        manifest_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
        unit_count INT UNSIGNED NOT NULL DEFAULT 0,
        last_access_at BIGINT NOT NULL,
        error_code VARCHAR(64) NULL,
        KEY idx_artifacts_file (file_id),
        KEY idx_artifacts_access (state, last_access_at),
        CONSTRAINT fk_artifact_file FOREIGN KEY (file_id) REFERENCES parse_files(file_id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS parse_jobs (
        job_id CHAR(36) NOT NULL PRIMARY KEY,
        artifact_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        state VARCHAR(16) NOT NULL,
        attempt BIGINT UNSIGNED NOT NULL,
        generation BIGINT UNSIGNED NOT NULL,
        lease_owner VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
        lease_until BIGINT NULL,
        progress INT UNSIGNED NOT NULL DEFAULT 0,
        error_code VARCHAR(64) NULL,
        UNIQUE KEY uq_job_artifact (artifact_key),
        KEY idx_jobs_lease (state, lease_until),
        CONSTRAINT fk_job_artifact FOREIGN KEY (artifact_key) REFERENCES parse_artifacts(artifact_key) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS parse_artifact_read_leases (
        id CHAR(36) NOT NULL PRIMARY KEY,
        artifact_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        generation BIGINT UNSIGNED NOT NULL,
        lease_owner VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        lease_until BIGINT NOT NULL,
        KEY idx_read_generation (artifact_key, generation, lease_until),
        KEY idx_read_expiry (lease_until),
        CONSTRAINT fk_read_artifact FOREIGN KEY (artifact_key) REFERENCES parse_artifacts(artifact_key) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS parse_artifact_retirements (
        artifact_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        generation BIGINT UNSIGNED NOT NULL,
        retired_at BIGINT NOT NULL,
        PRIMARY KEY (artifact_key, generation),
        CONSTRAINT fk_retired_artifact FOREIGN KEY (artifact_key) REFERENCES parse_artifacts(artifact_key) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS parse_artifact_flat_archives (
        artifact_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        generation BIGINT UNSIGNED NOT NULL,
        manifest_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        archived_at BIGINT NOT NULL,
        CONSTRAINT fk_flat_archive_artifact FOREIGN KEY (artifact_key) REFERENCES parse_artifacts(artifact_key) ON DELETE CASCADE
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
