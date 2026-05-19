// database.js - Single PostgreSQL pool with mssql compatibility wrapper
const { Pool } = require('pg');

// Create ONE pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Helper to convert @param placeholders to $1, $2... preserving same name to same number
function convertSql(sql, paramOrder) {
  const paramMap = new Map();
  let index = 1;
  for (const name of paramOrder) {
    if (!paramMap.has(name)) {
      paramMap.set(name, index++);
    }
  }
  return sql.replace(/@(\w+)/g, (match, name) => {
    const num = paramMap.get(name);
    if (!num) throw new Error(`Parameter @${name} used but not provided via .input()`);
    return `$${num}`;
  });
}

// Create a request object that mimics mssql's request()
function createRequest() {
  const inputs = [];
  const request = {
    input: (name, type, value) => {
      inputs.push({ name, value });
      return request;
    },
    query: async (sqlString) => {
      const paramNames = inputs.map(inp => inp.name);
      const paramValues = inputs.map(inp => inp.value);
      const convertedSql = convertSql(sqlString, paramNames);
      try {
        const result = await pool.query(convertedSql, paramValues);
        return {
          recordset: result.rows,
          rowsAffected: [result.rowCount],
        };
      } catch (err) {
        console.error('Query error:', err);
        throw err;
      }
    },
  };
  return request;
}

// Attach request() to the pool
pool.request = createRequest;

// Make sql types callable (they just return a dummy object)
const makeType = () => ({ type: 'dummy' });
const sql = {
  Int: makeType,
  NVarChar: makeType,
  VarChar: makeType,
  DateTime: makeType,
  Bit: makeType,
  Decimal: makeType,
  Float: makeType,
  BigInt: makeType,
};

// Export the same pool everywhere
module.exports = {
  pool,          // the actual pool
  sql,           // dummy types
  poolConnect: Promise.resolve(), // no-op
  query: (text, params) => pool.query(text, params), // direct access
};