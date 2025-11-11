const mysql = require("mysql2/promise");
require("dotenv").config();

// Crear un pool de conexiones
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT || 3306),
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  queueLimit: 0,
});

// Función para probar la conexión
async function ping() {
  try {
    const [rows] = await pool.query("SELECT 1 AS ok");
    if (rows[0].ok === 1) {
      console.log("Conexión exitosa a la base de datos");
      return true;
    }
  } catch (error) {
    console.error("Error al conectar con la base de datos:", error.message);
    return false;
  }
}

module.exports = { pool, ping };
