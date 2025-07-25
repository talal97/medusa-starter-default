import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules, ProductStatus } from "@medusajs/framework/utils";
import { createProductsWorkflow, createInventoryLevelsWorkflow, createProductCategoriesWorkflow } from "@medusajs/medusa/core-flows";

/**
 * Import products from DummyJSON API into Medusa store
 * Fetches product data and creates products with inventory
 */
export default async function importDummyProducts({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const stockLocationModuleService = container.resolve(Modules.STOCK_LOCATION);
  const salesChannelModuleService = container.resolve(Modules.SALES_CHANNEL);

  logger.info("Starting import of products from DummyJSON API...");

  try {
    // Fetch products from DummyJSON API
    const response = await fetch('https://dummyjson.com/products');
    const data = await response.json();
    const products = data.products;

    logger.info(`Found ${products.length} products to import`);

    // Get default sales channel and stock location
    const salesChannels = await salesChannelModuleService.listSalesChannels(
      { name: "Default Sales Channel" },
      {}
    );
    const stockLocations = await stockLocationModuleService.listStockLocations({}, {});
    
    if (!salesChannels.length) {
      throw new Error("Default Sales Channel not found. Please run the main seed script first.");
    }
    
    if (!stockLocations.length) {
      throw new Error("No stock locations found. Please run the main seed script first.");
    }

    const defaultSalesChannel = salesChannels[0];
    const stockLocation = stockLocations[0];

    // Create categories first
    const uniqueCategories = [...new Set(products.map((p: any) => p.category).filter(Boolean))] as string[];
    logger.info(`Creating ${uniqueCategories.length} product categories...`);
    
    const categoryData = uniqueCategories.map((category: string) => ({
      name: category,
      handle: category.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
      is_active: true,
    }));

    const { result: createdCategories } = await createProductCategoriesWorkflow(container).run({
      input: { product_categories: categoryData },
    });

    // Create a map of category names to IDs
    const categoryMap = new Map<string, string>();
    createdCategories.forEach((cat: any) => {
      categoryMap.set(cat.name, cat.id);
    });

    // Transform DummyJSON products to Medusa format
    const medusaProducts = products.map((product: any) => ({
      title: product.title,
      subtitle: product.brand || "",
      description: product.description,
      handle: product.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
      status: ProductStatus.PUBLISHED,
      thumbnail: product.thumbnail,
      images: product.images?.map((url: string) => ({ url })) || [{ url: product.thumbnail }],
      options: [
        {
          title: "Default",
          values: ["Default"],
        },
      ],
      variants: [
        {
          title: "Default Variant",
          sku: product.sku || `SKU-${product.id}`,
          prices: [
            {
              currency_code: "usd",
              amount: Math.round(product.price * 100), // Convert to cents
            },
            {
              currency_code: "eur", 
              amount: Math.round(product.price * 0.85 * 100), // Rough EUR conversion
            },
          ],
          options: {
            Default: "Default",
          },
          manage_inventory: true,
        },
      ],
      sales_channels: [{ id: defaultSalesChannel.id }],
      categories: product.category && categoryMap.has(product.category) 
        ? [{ id: categoryMap.get(product.category) }] 
        : [],
      weight: product.weight || 0,
      length: product.dimensions?.depth || 0,
      width: product.dimensions?.width || 0,
      height: product.dimensions?.height || 0,
    }));

    // Create products in batches
    const batchSize = 10;
    const createdProducts: any[] = [];
    
    for (let i = 0; i < medusaProducts.length; i += batchSize) {
      const batch = medusaProducts.slice(i, i + batchSize);
      logger.info(`Creating products batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(medusaProducts.length / batchSize)}`);
      
      const { result } = await createProductsWorkflow(container).run({
        input: { products: batch },
      });
      
      createdProducts.push(...result);
    }

    logger.info(`Successfully created ${createdProducts.length} products`);

    // Create inventory levels for all variants
    const inventoryLevels: any[] = [];
    for (let i = 0; i < createdProducts.length; i++) {
      const product: any = createdProducts[i];
      const originalProduct: any = products[i];
      
      for (const variant of product.variants || []) {
        if (variant.inventory_items && variant.inventory_items.length > 0) {
          inventoryLevels.push({
            inventory_item_id: variant.inventory_items[0].inventory_item_id,
            location_id: stockLocation.id,
            stocked_quantity: originalProduct.stock || 100,
          });
        }
      }
    }

    // Create inventory levels in batches
    for (let i = 0; i < inventoryLevels.length; i += batchSize) {
      const batch = inventoryLevels.slice(i, i + batchSize);
      logger.info(`Creating inventory batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(inventoryLevels.length / batchSize)}`);
      
      await createInventoryLevelsWorkflow(container).run({
        input: { inventory_levels: batch },
      });
    }

    logger.info(`Successfully imported ${createdProducts.length} products with inventory from DummyJSON API`);
    logger.info("Product categories imported:");
    
    // Log unique categories
    const categories = [...new Set(products.map((p: any) => p.category).filter(Boolean))];
    categories.forEach(category => logger.info(`- ${category}`));

  } catch (error) {
    logger.error("Error importing products:", error);
    throw error;
  }
}