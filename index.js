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

function validatePostBody(body) {
  if (!body || typeof body !== "object") return "Body inválido";
  const { user_id, status, details } = body;
  if (!user_id || !status) return "user_id y status son obligatorios";
  if (!Array.isArray(details) || details.length === 0)
    return "Debe haber al menos 1 detalle";
  if (details.length > 5)
    return "No se pueden guardar más de 5 productos por compra";
  for (const d of details) {
    if (!d.product_id || !d.quantity || !("price" in d))
      return "Cada detalle requiere product_id, quantity y price";
    if (d.quantity <= 0) return "Las cantidades deben ser > 0";
    if (Number(d.price) < 0) return "El precio no puede ser negativo";
  }
  return null;
}

async function buildPurchasesFromRows(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.id)) {
      map.set(r.id, {
        id: r.id,
        user: r.user_name,
        total: Number(r.total),
        status: r.status,
        purchase_date: r.purchase_date,
        details: [],
      });
    }
    if (r.detail_id) {
      map.get(r.id).details.push({
        id: r.detail_id,
        product: r.product_name,
        quantity: r.quantity,
        price: Number(r.price),
        subtotal: Number(r.subtotal),
      });
    }
  }
  return Array.from(map.values());
}

// POST /api/purchases  -> crea compra + descuenta stock
app.post(
  "/api/purchases",
  ah(async (req, res) => {
    const err = validatePostBody(req.body);
    if (err) return res.status(400).json({ message: err });

    const { user_id, status, details } = req.body;
    const total = details.reduce(
      (acc, d) => acc + Number(d.price) * Number(d.quantity),
      0
    );
    if (total > 3500)
      return res
        .status(400)
        .json({ message: "El total no puede superar $3500" });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Verificar stock (bloqueo de fila)
      for (const d of details) {
        const [p] = await conn.query(
          "SELECT id, stock FROM products WHERE id = ? FOR UPDATE",
          [d.product_id]
        );

        if (p.length === 0) {
          throw new Error(`Producto ${d.product_id} no existe`);
        }

        if (p[0].stock < d.quantity) {
          throw new Error(`Stock insuficiente para producto ${d.product_id}`);
        }
      }

      // Insert cabecera
      const [ins] = await conn.query(
        "INSERT INTO purchases (user_id, total, status, purchase_date) VALUES (?, ?, ?, NOW())",
        [user_id, total, status]
      );
      const purchaseId = ins.insertId;

      // Insert detalles + descuento stock
      for (const d of details) {
        const subtotal = Number(d.price) * Number(d.quantity);
        await conn.query(
          "INSERT INTO purchase_details (purchase_id, product_id, quantity, price, subtotal) VALUES (?, ?, ?, ?, ?)",
          [purchaseId, d.product_id, d.quantity, d.price, subtotal]
        );
        await conn.query("UPDATE products SET stock = stock - ? WHERE id = ?", [
          d.quantity,
          d.product_id,
        ]);
      }

      await conn.commit();
      res.status(201).json({ id: purchaseId, message: "Compra creada" });
    } catch (e) {
      await conn.rollback();
      res.status(400).json({ message: e.message });
    } finally {
      conn.release();
    }
  })
);

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
