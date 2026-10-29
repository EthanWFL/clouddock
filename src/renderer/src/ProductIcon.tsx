import { Box, Cloud, Database, FileSearch, GitBranch, Network, RadioTower, ScrollText } from "lucide-react";
import type { Product } from "../../shared/model";

export function ProductIcon({ product, size = 16 }: { product: Product; size?: number }) {
  const props = {
    "aria-hidden": true,
    className: "product-icon",
    "data-product": product,
    size,
  } as const;
  switch (product) {
    case "ack":
      return <Box {...props} />;
    case "kafka":
      return <RadioTower {...props} />;
    case "mse":
      return <Network {...props} />;
    case "dms":
      return <Database {...props} />;
    case "codeup":
      return <GitBranch {...props} />;
    case "sls":
      return <ScrollText {...props} />;
    case "aliyun":
      return <Cloud {...props} />;
  }
}

export function ConsoleEntryIcon({
  product,
  query = false,
  size = 16,
}: {
  product: Product;
  query?: boolean;
  size?: number;
}) {
  if (query) {
    return (
      <FileSearch
        aria-hidden="true"
        className="entry-kind-icon"
        data-entry-kind="query"
        data-product={product}
        size={size}
      />
    );
  }
  return <ProductIcon product={product} size={size} />;
}
