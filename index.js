const express = require("express");
const app = express();
const port = 3000;

app.use(express.json());

const { pool, ping } = require("./connection"); // ← importa tu conexión

// RUTA DE PRUEBA
app.get("/", (req, res) => {
  res.send("Hello World!");
});

// RUTAS DE USUARIOS
app.get("/usuarios", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM users");
    res.json(rows);
  } catch (err) {
    console.error("Error al obtener usuarios:", err);
    res.status(500).send("Error en el servidor");
  }
});

app.post("/usuarios", async (req, res) => {
  const { nombre, email, telefono, edad } = req.body;

  if (!nombre || !email) {
    return res
      .status(400)
      .json({ error: "Los campos nombre y email son obligatorios" });
  }

  try {
    const query =
      "INSERT INTO users (nombre, email, telefono, edad) VALUES (?, ?, ?, ?)";
    const [result] = await pool.query(query, [
      nombre,
      email,
      telefono || null,
      edad || null,
    ]);

    res.status(201).json({
      message: "Usuario creado exitosamente",
      id: result.insertId,
      usuario: { id: result.insertId, nombre, email, telefono, edad },
    });
  } catch (err) {
    console.error("Error al crear usuario:", err);

    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "El email ya está registrado" });
    }

    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// Aquí viene el nuevo bloque con verificación de base de datos
app.listen(port, async () => {
  const dbOk = await ping();
  if (dbOk) {
    console.log(` Server listening at http://localhost:${port}`);
  } else {
    console.log(
      " El servidor está corriendo, pero la base de datos no respondió."
    );
  }
});
