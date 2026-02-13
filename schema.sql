CREATE DATABASE IF NOT EXISTS `countdown-scraper`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `countdown-scraper`;

CREATE TABLE IF NOT EXISTS products (
  id VARCHAR(20) NOT NULL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  size VARCHAR(50) DEFAULT NULL,
  current_price DECIMAL(10,2) NOT NULL,
  last_updated DATETIME NOT NULL,
  last_checked DATETIME NOT NULL,
  source_site VARCHAR(100) NOT NULL DEFAULT 'countdown.co.nz',
  unit_price DECIMAL(10,2) DEFAULT NULL,
  unit_name VARCHAR(20) DEFAULT NULL,
  original_unit_quantity INT DEFAULT NULL,
  INDEX idx_name (name),
  INDEX idx_last_checked (last_checked)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS product_categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id VARCHAR(20) NOT NULL,
  category VARCHAR(100) NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  UNIQUE KEY unique_product_category (product_id, category)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS price_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id VARCHAR(20) NOT NULL,
  date DATETIME NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  INDEX idx_product_date (product_id, date)
) ENGINE=InnoDB;