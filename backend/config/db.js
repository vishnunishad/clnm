const mysql = require('mysql2/promise');

const mysqlUrl = process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || process.env.DATABASE_URL || '';

// Aiven MySQL requires SSL in production
const sslConfig = process.env.NODE_ENV === 'production'
  ? { rejectUnauthorized: true }
  : false;

const poolConfig = mysqlUrl
  ? {
      uri: mysqlUrl,
      ssl: sslConfig,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      timezone: '+05:30'
    }
  : {
      host:     process.env.DB_HOST     || process.env.MYSQLHOST     || 'localhost',
      port:     Number(process.env.DB_PORT || process.env.MYSQLPORT  || 3306),
      user:     process.env.DB_USER     || process.env.MYSQLUSER     || 'root',
      password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || '',
      database: process.env.DB_NAME     || process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || 'cln_db',
      ssl:      sslConfig,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      timezone: '+05:30'
    };

const pool = mysql.createPool(poolConfig);

// Test connection on startup
pool.getConnection()
  .then(conn => {
    console.log('MySQL connected successfully');
    conn.release();
  })
  .catch(err => {
    console.error('MySQL connection failed:', err.message);
    console.error('   → Make sure DB credentials and SSL settings are correct');
  });

module.exports = pool;
