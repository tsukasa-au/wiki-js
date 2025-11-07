const tsquery = require('pg-tsquery')()
const stream = require('stream')
const Promise = require('bluebird')
const pipeline = Promise.promisify(stream.pipeline)

/* global WIKI */

module.exports = {
  async activate() {
    if (WIKI.config.db.type !== 'sqlite') {
      throw new WIKI.Error.SearchActivationFailed('Must use SQLite database to activate this engine!')
    }
  },
  async deactivate() {
    WIKI.logger.info(`(SEARCH/SQLITE) Dropping index tables...`)
    await WIKI.models.knex.raw(`
      DROP TRIGGER IF EXISTS pages_trigger_after_insert
    `)
    await WIKI.models.knex.raw(`
      DROP TRIGGER IF EXISTS pages_trigger_after_delete
    `)
    await WIKI.models.knex.raw(`
      DROP TRIGGER IF EXISTS pages_trigger_after_update
    `)
    await WIKI.models.knex.schema.dropTable('pages_fts')
    WIKI.logger.info(`(SEARCH/SQLITE) Index tables have been dropped.`)
  },
  /**
   * INIT
   */
  async init() {
    WIKI.logger.info(`(SEARCH/SQLITE) Initializing...`)

    // -> Create Search Index
    const indexExists = await WIKI.models.knex.schema.hasTable('pages_fts')
    if (!indexExists) {
      WIKI.logger.info(`(SEARCH/SQLITE) Creating Pages FTS table...`)
      // -> Create the actual FTS index table
      // NOTE: The unicode61 tokenizer still effectively splits on spaces,
      // and thus does not work for CJK languages that require more complex
      // segmentation. :(
      await WIKI.models.knex.raw(`
        CREATE VIRTUAL TABLE pages_fts
        USING fts5(title, description, content, content='pages', content_rowid='id', tokenize='porter unicode61')
      `)
      // -> Add triggers to keep FTS index up to date
      await WIKI.models.knex.raw(`
        CREATE TRIGGER pages_trigger_after_insert AFTER INSERT ON pages BEGIN
          INSERT INTO pages_fts(rowid, title, description, content) VALUES (new.id, new.title, new.description, new.content);
        END
      `)
      await WIKI.models.knex.raw(`
        CREATE TRIGGER pages_trigger_after_delete AFTER DELETE ON pages BEGIN
          INSERT INTO pages_fts(pages_fts, rowid, title, description, content) VALUES('delete', old.id, old.title, old.description, old.content);
        END
      `)
      await WIKI.models.knex.raw(`
        CREATE TRIGGER pages_trigger_after_update AFTER UPDATE ON pages BEGIN
          INSERT INTO pages_fts(pages_fts, rowid, title, description, content) VALUES('delete', old.id, old.title, old.description, old.content);
          INSERT INTO pages_fts(rowid, title, description, content) VALUES (new.id, new.title, new.description, new.content);
        END
      `)
      // -> Force a rebuild of the FTS table
      await WIKI.models.knex.raw(`
        INSERT INTO pages_fts(pages_fts) VALUES ('rebuild')
      `)
    }

    WIKI.logger.info(`(SEARCH/SQLITE) Initialization completed.`)
  },
  /**
   * QUERY
   *
   * @param {String} q Query
   * @param {Object} opts Additional options
   */
  async query(q, opts) {
    try {
      let qry = `
        SELECT
          pages.id AS id,
          pages.path AS path,
          pages.localeCode AS locale,
          pages.title AS title,
          pages.description AS description
        FROM
          pages JOIN pages_fts ON (pages.id = pages_fts.rowid)
        WHERE
          pages.isPublished = true
          AND pages_fts MATCH ?
      `
      let qryEnd = `\
        ORDER BY pages_fts.rank DESC
        LIMIT ${WIKI.config.search.maxHits}
      `
      let qryParams = []
      qryParams.push(q)

      if (opts.locale) {
        qry = `${qry} AND pages.localeCode = ?`
        qryParams.push(opts.locale)
      }
      if (opts.path) {
        qry = `${qry} AND pages.path LIKE ?`
        qryParams.push(`${opts.path}%`)
      }
      const results = Array.from(await WIKI.models.knex.raw(`
        ${qry} ${qryEnd};
      `, qryParams))
      return {
        results: results,
        // TODO: Figure out how to pull tokens from the FTS index to give as
        // suggestions.
        suggestions: [],
        totalHits: results.length
      }
    } catch (err) {
      WIKI.logger.warn('Search Engine Error:')
      WIKI.logger.warn(err)
    }
  },
  /**
   * CREATE
   *
   * @param {Object} page Page to create
   */
  async created(page) {
    /* Not needed (inserts are handled by trigger). */
  },
  /**
   * UPDATE
   *
   * @param {Object} page Page to update
   */
  async updated(page) {
    /* Not needed (updates are handled by trigger). */
  },
  /**
   * DELETE
   *
   * @param {Object} page Page to delete
   */
  async deleted(page) {
    /* Not needed (deletes are handled by trigger). */
  },
  /**
   * RENAME
   *
   * @param {Object} page Page to rename
   */
  async renamed(page) {
    /* Not needed (renames are handled by trigger). */
  },
  /**
   * REBUILD INDEX
   */
  async rebuild() {
    WIKI.logger.info(`(SEARCH/SQLITE) Rebuilding Index...`)
    await WIKI.models.knex.raw(`
      INSERT INTO pages_fts(pages_fts) VALUES ('rebuild')
      `)

  }
}
