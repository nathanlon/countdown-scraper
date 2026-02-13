// Used by index.ts for creating and accessing items stored in MySQL

import * as dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: `.env.local`, override: true });

import mysql from "mysql2/promise";
import { logError, log, colour, validCategories } from "./utilities";
import { Product, UpsertResponse, ProductResponse, DatedPrice } from "./typings";

let pool: mysql.Pool;

export async function establishMySQL() {
  const host = process.env.MYSQL_HOST || "127.0.0.1";
  const user = process.env.MYSQL_USER || "root";
  const password = process.env.MYSQL_PASSWORD || "r";
  const database = process.env.MYSQL_DATABASE || "countdown-scraper";

  pool = mysql.createPool({
    host,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 10,
  });

  // Test connection
  try {
    const conn = await pool.getConnection();
    conn.release();
    log(colour.blue, `MySQL connected to ${database}`);
  } catch (error) {
    throw Error(`MySQL connection failed: ${error}`);
  }
}

// upsertProductToMySQL()
// ----------------------
// Inserts or updates a product in MySQL,
//  returns an UpsertResponse based on if and how the Product was updated

export async function upsertProductToMySQL(
  scrapedProduct: Product
): Promise<UpsertResponse> {
  try {
    // Check MySQL for any existing product using id
    const [rows] = await pool.execute(
      "SELECT * FROM products WHERE id = ?",
      [scrapedProduct.id]
    );
    const existingProducts = rows as any[];

    if (existingProducts.length > 0) {
      // Product exists - load full product with categories and price history
      const dbProduct = await loadProductFromDB(existingProducts[0]);
      const response = buildUpdatedProduct(scrapedProduct, dbProduct);

      // Update product in database
      await updateProductInDB(response.product);

      // If price changed, insert new price history entry
      if (response.upsertType === UpsertResponse.PriceChanged) {
        const latestPrice =
          scrapedProduct.priceHistory[scrapedProduct.priceHistory.length - 1];
        await pool.execute(
          "INSERT INTO price_history (product_id, date, price) VALUES (?, ?, ?)",
          [scrapedProduct.id, latestPrice.date, latestPrice.price]
        );
      }

      // Update categories if changed
      if (
        response.upsertType === UpsertResponse.InfoChanged ||
        response.upsertType === UpsertResponse.PriceChanged
      ) {
        await updateCategories(response.product.id, response.product.category);
      }

      return response.upsertType;
    } else {
      // New product - insert
      await insertProductToDB(scrapedProduct);

      console.log(
        `  New Product: ${scrapedProduct.name.slice(0, 47).padEnd(47)}` +
          ` | $ ${scrapedProduct.currentPrice}`
      );

      return UpsertResponse.NewProduct;
    }
  } catch (e: any) {
    logError(e.message || e);
    return UpsertResponse.Failed;
  }
}

// loadProductFromDB()
// -------------------
// Loads a full Product object from a MySQL row, including categories and price history

async function loadProductFromDB(row: any): Promise<Product> {
  // Load categories
  const [catRows] = await pool.execute(
    "SELECT category FROM product_categories WHERE product_id = ?",
    [row.id]
  );
  const categories = (catRows as any[]).map((r) => r.category);

  // Load price history
  const [priceRows] = await pool.execute(
    "SELECT date, price FROM price_history WHERE product_id = ? ORDER BY date ASC",
    [row.id]
  );
  const priceHistory: DatedPrice[] = (priceRows as any[]).map((r) => ({
    date: new Date(r.date),
    price: parseFloat(r.price),
  }));

  return {
    id: row.id,
    name: row.name,
    size: row.size || undefined,
    currentPrice: parseFloat(row.current_price),
    lastUpdated: new Date(row.last_updated),
    lastChecked: new Date(row.last_checked),
    priceHistory,
    sourceSite: row.source_site,
    category: categories,
    unitPrice: row.unit_price ? parseFloat(row.unit_price) : undefined,
    unitName: row.unit_name || undefined,
    originalUnitQuantity: row.original_unit_quantity || undefined,
  };
}

// insertProductToDB()
// -------------------
// Inserts a new product into MySQL with its categories and price history

async function insertProductToDB(product: Product) {
  await pool.execute(
    `INSERT INTO products (id, name, size, current_price, last_updated, last_checked, source_site, unit_price, unit_name, original_unit_quantity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      product.id,
      product.name,
      product.size || null,
      product.currentPrice,
      product.lastUpdated,
      product.lastChecked,
      product.sourceSite,
      product.unitPrice || null,
      product.unitName || null,
      product.originalUnitQuantity || null,
    ]
  );

  // Insert categories
  for (const category of product.category) {
    await pool.execute(
      "INSERT INTO product_categories (product_id, category) VALUES (?, ?)",
      [product.id, category]
    );
  }

  // Insert initial price history
  for (const ph of product.priceHistory) {
    await pool.execute(
      "INSERT INTO price_history (product_id, date, price) VALUES (?, ?, ?)",
      [product.id, ph.date, ph.price]
    );
  }
}

// updateProductInDB()
// -------------------
// Updates an existing product row in MySQL

async function updateProductInDB(product: Product) {
  await pool.execute(
    `UPDATE products SET
       name = ?, size = ?, current_price = ?, last_updated = ?, last_checked = ?,
       source_site = ?, unit_price = ?, unit_name = ?, original_unit_quantity = ?
     WHERE id = ?`,
    [
      product.name,
      product.size || null,
      product.currentPrice,
      product.lastUpdated,
      product.lastChecked,
      product.sourceSite,
      product.unitPrice || null,
      product.unitName || null,
      product.originalUnitQuantity || null,
      product.id,
    ]
  );
}

// updateCategories()
// ------------------
// Replaces all categories for a product

async function updateCategories(productId: string, categories: string[]) {
  await pool.execute(
    "DELETE FROM product_categories WHERE product_id = ?",
    [productId]
  );
  for (const category of categories) {
    await pool.execute(
      "INSERT INTO product_categories (product_id, category) VALUES (?, ?)",
      [productId, category]
    );
  }
}

// buildUpdatedProduct()
// ---------------------
// This takes a freshly scraped product and compares it with a found database product.
// It returns an updated product with data from both product versions

function buildUpdatedProduct(
  scrapedProduct: Product,
  dbProduct: Product
): ProductResponse {
  // Parse dates for comparison (yyyy-mm-dd)
  let dbDay = dbProduct.lastUpdated instanceof Date
    ? dbProduct.lastUpdated.toISOString().slice(0, 10)
    : dbProduct.lastUpdated.toString().slice(0, 10);
  let scrapedDay = scrapedProduct.lastUpdated.toISOString().slice(0, 10);

  // Measure the price difference between the new scraped product and the old db product
  const priceDifference = Math.abs(
    dbProduct.currentPrice - scrapedProduct.currentPrice
  );

  // If price has changed by more than $0.05, and not on the same day
  if (priceDifference > 0.05 && dbDay != scrapedDay) {
    // Push scraped priceHistory into existing priceHistory array
    dbProduct.priceHistory.push(scrapedProduct.priceHistory[0]);

    // Set the scrapedProduct to use the updated priceHistory
    scrapedProduct.priceHistory = dbProduct.priceHistory;

    // Return completed Product ready for uploading
    logPriceChange(dbProduct, scrapedProduct.currentPrice);
    return {
      upsertType: UpsertResponse.PriceChanged,
      product: scrapedProduct,
    };
  }

  // If any db categories are not included within the list of valid ones, update to scraped ones
  else if (
    !dbProduct.category.every((category) => {
      const isValid = validCategories.includes(category);
      return isValid;
    }) ||
    dbProduct.category === null
  ) {
    console.log(
      `  Categories Changed: ${scrapedProduct.name
        .padEnd(40)
        .substring(0, 40)}` +
        ` - ${dbProduct.category.join(" ")} > ${scrapedProduct.category.join(
          " "
        )}`
    );

    // Update everything but priceHistory and lastUpdated
    scrapedProduct.priceHistory = dbProduct.priceHistory;
    scrapedProduct.lastUpdated = dbProduct.lastUpdated;

    // Return completed Product ready for uploading
    return {
      upsertType: UpsertResponse.InfoChanged,
      product: scrapedProduct,
    };
  }

  // Update other info
  else if (
    dbProduct.sourceSite !== scrapedProduct.sourceSite ||
    dbProduct.category.join(" ") !== scrapedProduct.category.join(" ") ||
    dbProduct.size !== scrapedProduct.size ||
    dbProduct.unitPrice !== scrapedProduct.unitPrice ||
    dbProduct.unitName !== scrapedProduct.unitName ||
    dbProduct.originalUnitQuantity !== scrapedProduct.originalUnitQuantity
  ) {
    // Update everything but priceHistory and lastUpdated
    scrapedProduct.priceHistory = dbProduct.priceHistory;
    scrapedProduct.lastUpdated = dbProduct.lastUpdated;

    // Return completed Product ready for uploading
    return {
      upsertType: UpsertResponse.InfoChanged,
      product: scrapedProduct,
    };
  } else {
    // Nothing has changed, only update lastChecked
    dbProduct.lastChecked = scrapedProduct.lastChecked;
    return {
      upsertType: UpsertResponse.AlreadyUpToDate,
      product: dbProduct,
    };
  }
}

// logPriceChange()
// ----------------
// Log a per product price change message,
//  coloured green for price reduction, red for price increase

export function logPriceChange(product: Product, newPrice: number) {
  const priceIncreased = newPrice > product.currentPrice;
  log(
    priceIncreased ? colour.red : colour.green,
    "  Price " +
      (priceIncreased ? "Up   : " : "Down : ") +
      product.name.slice(0, 47).padEnd(47) +
      " | $" +
      product.currentPrice.toString().padStart(4) +
      " > $" +
      newPrice
  );
}

// closeMySQL()
// ------------
// Close the connection pool

export async function closeMySQL() {
  if (pool) await pool.end();
}