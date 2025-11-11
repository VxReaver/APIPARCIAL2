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


// PUT /api/purchases/:id  -> re-calcula total, re-aplica stock; bloquea si COMPLETED
app.put("/api/purchases/:id", ah(async (req, res) => {
  const id = Number(req.params.id);
  if(!id) return res.status(400).json({ message: "ID inválido" });

  const conn = await pool.getConnection();
  try{
    await conn.beginTransaction();

    const [purch] = await conn.query("SELECT * FROM purchases WHERE id = ? FOR UPDATE", [id]);
    if(purch.length === 0) throw new Error("Compra no encontrada");
    if(purch[0].status === "COMPLETED")
      return res.status(409).json({ message: "Una compra COMPLETED no puede modificarse" });

    // Devolver stock actual
    const [curDet] = await conn.query("SELECT product_id, quantity FROM purchase_details WHERE purchase_id = ?", [id]);
    for(const d of curDet){
      await conn.query("UPDATE products SET stock = stock + ? WHERE id = ?", [d.quantity, d.product_id]);
    }
    // Borrar detalles actuales
    await conn.query("DELETE FROM purchase_details WHERE purchase_id = ?", [id]);

    // Preparar nuevos valores
    const newUserId = req.body.user_id ?? purch[0].user_id;
    const newStatus = req.body.status ?? purch[0].status;
    const newDetails = Array.isArray(req.body.details) ? req.body.details : [];

    if(newDetails.length){
      if(newDetails.length > 5) throw new Error("No se pueden guardar más de 5 productos por compra");
      for(const d of newDetails){
        if(!d.product_id || !d.quantity || (!("price" in d))) throw new Error("Cada detalle requiere product_id, quantity y price");
        if(d.quantity <= 0) throw new Error("Las cantidades deben ser > 0");
        if(Number(d.price) < 0) throw new Error("El precio no puede ser negativo");
      }
     // Verificar stock para nuevos detalles
for (const d of newDetails) {
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


    const newTotal = newDetails.length
      ? newDetails.reduce((acc,d)=> acc + (Number(d.price) * Number(d.quantity)), 0)
      : Number(purch[0].total);

    if(newTotal > 3500) throw new Error("El total no puede superar $3500");

    // Insertar nuevos detalles + descontar stock
    for(const d of newDetails){
      const subtotal = Number(d.price) * Number(d.quantity);
      await conn.query(
        "INSERT INTO purchase_details (purchase_id, product_id, quantity, price, subtotal) VALUES (?, ?, ?, ?, ?)",
        [id, d.product_id, d.quantity, d.price, subtotal]
      );
      await conn.query("UPDATE products SET stock = stock - ? WHERE id = ?", [d.quantity, d.product_id]);
    }

    // Update cabecera
    await conn.query(
      "UPDATE purchases SET user_id = ?, total = ?, status = ? WHERE id = ?",
      [newUserId, newTotal, newStatus, id]
    );

app.put("/ventas/:id", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    // ...
    await conn.commit();
    res.json({ id, message: "Compra actualizada" });
  } catch (e) {
    await conn.rollback();
    res.status(400).json({ message: e.message });
  } finally {
    conn.release();
  }
});



// DELETE /api/purchases/:id  -> devuelve stock; bloquea si COMPLETED
app.delete("/api/purchases/:id", ah(async (req, res) => {
  const id = Number(req.params.id);
  if(!id) return res.status(400).json({ message: "ID inválido" });

  const conn = await pool.getConnection();
  try{
    await conn.beginTransaction();

    const [purch] = await conn.query("SELECT status FROM purchases WHERE id = ? FOR UPDATE", [id]);
    if(purch.length === 0) throw new Error("Compra no encontrada");
    if(purch[0].status === "COMPLETED")
      return res.status(409).json({ message: "No se pueden borrar compras COMPLETED" });

    const [det] = await conn.query("SELECT product_id, quantity FROM purchase_details WHERE purchase_id = ?", [id]);
    for(const d of det){
      await conn.query("UPDATE products SET stock = stock + ? WHERE id = ?", [d.quantity, d.product_id]);
    }

    await conn.query("DELETE FROM purchase_details WHERE purchase_id = ?", [id]);
    await conn.query("DELETE FROM purchases WHERE id = ?", [id]);

    await conn.commit();
    res.json({ id, message: "Compra eliminada" });
  }catch(e){
    await conn.rollback();
    res.status(400).json({ message: e.message });
  }finally{
    conn.release();
  }
}));

// GET /api/purchases (join bonito)
app.get("/api/purchases", ah(async (_req, res) => {
  const [rows] = await pool.query(`
    SELECT 
      p.id, p.total, p.status, p.purchase_date,
      u.name AS user_name,
      pd.id AS detail_id, pd.quantity, pd.price, pd.subtotal,
      pr.name AS product_name
    FROM purchases p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN purchase_details pd ON pd.purchase_id = p.id
    LEFT JOIN products pr ON pr.id = pd.product_id
    ORDER BY p.id DESC, detail_id ASC
  `);
  const data = await buildPurchasesFromRows(rows);
  res.json(data);
}));

// GET /api/purchases/:id (join)
app.get("/api/purchases/:id", ah(async (req, res) => {
  const id = Number(req.params.id);
  const [rows] = await pool.query(`
    SELECT 
      p.id, p.total, p.status, p.purchase_date,
      u.name AS user_name,
      pd.id AS detail_id, pd.quantity, pd.price, pd.subtotal,
      pr.name AS product_name
    FROM purchases p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN purchase_details pd ON pd.purchase_id = p.id
    LEFT JOIN products pr ON pr.id = pd.product_id
    WHERE p.id = ?
    ORDER BY detail_id ASC
  `, [id]);
  if(rows.length === 0) return res.status(404).json({ message: "Compra no encontrada" });
  const [obj] = await buildPurchasesFromRows(rows);
  res.json(obj);
}));

// -------------------- MIDDLEWARE DE ERRORES --------------------
app.use((err, _req, res, _next) => {
  console.error("Unhandled Error:", err);
  res.status(500).json({ error: "Error interno del servidor" });
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