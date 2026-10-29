import { Check, ChevronRight, CircleAlert, Cloud, Globe2, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { type ConfigurableProduct, type ProductRegionIds } from "../../shared/model";
import { getProductRegionIds, isRegionalProduct, PRODUCTS, productLabel, REGIONAL_PRODUCTS } from "../../shared/workspace-display";
import { REGIONS } from "../../shared/regions";
import { ProductIcon } from "./ProductIcon";
import { useRendererStore } from "./store";
import { Modal } from "./Modal";
import type { RegionalProduct } from "../../shared/products";

function ProductSelector({
  selected,
  productRegionIds,
  activeProduct,
  onActivate,
  onToggle,
  initialFocus = false,
}: {
  selected: readonly ConfigurableProduct[];
  productRegionIds: ProductRegionIds;
  activeProduct: ConfigurableProduct;
  onActivate: (product: ConfigurableProduct) => void;
  onToggle: (product: ConfigurableProduct, enabled: boolean) => void;
  initialFocus?: boolean;
}) {
  return (
    <div className="product-grid">
      {PRODUCTS.map((product, index) => {
        const checked = selected.includes(product);
        return (
          <div
            className={`product-option ${checked ? "selected" : ""} ${activeProduct === product ? "active" : ""}`}
            data-product={product}
            key={product}
          >
            <button
              className="product-option-main"
              data-modal-initial-focus={initialFocus && index === 0 ? "true" : undefined}
              type="button"
              aria-pressed={activeProduct === product}
              onClick={() => {
                onActivate(product);
                if (!checked) onToggle(product, true);
              }}
            >
              <ProductIcon product={product} size={17} />
              <span>{productLabel(product)}</span>
              <small>{isRegionalProduct(product)
                ? `${productRegionIds[product].length} 个地域`
                : "全局服务"}</small>
            </button>
            <label
              className="product-option-toggle"
              title={checked ? `停用 ${productLabel(product)}` : `启用 ${productLabel(product)}`}
            >
              <input
                type="checkbox"
                aria-label={`${productLabel(product)} 模块`}
                checked={checked}
                onChange={(event) => onToggle(product, event.target.checked)}
              />
              <span className="module-checkbox" aria-hidden="true">
                {checked && <Check size={12} />}
              </span>
            </label>
          </div>
        );
      })}
    </div>
  );
}

function RegionSelector({
  product,
  selected,
  onChange,
}: {
  product: RegionalProduct;
  selected: readonly string[];
  onChange: (regionIds: string[]) => void;
}) {
  const regions = REGIONS.filter((region) => getProductRegionIds(product, [region.id]).length > 0);

  return (
    <div className="region-grid compact">
      {regions.map((region) => {
        const checked = selected.includes(region.id);
        const isLastSelectedRegion = checked && selected.length === 1;
        return (
          <label
            className={`region-option ${checked ? "selected" : ""}`}
            key={region.id}
            title={isLastSelectedRegion ? "至少保留一个地域" : undefined}
          >
            <input
              type="checkbox"
              aria-label={`${productLabel(product)} · ${region.name}`}
              checked={checked}
              disabled={isLastSelectedRegion}
              onChange={() => onChange(checked
                ? selected.filter((id) => id !== region.id)
                : [...selected, region.id])}
            />
            <span>{region.name}</span>
            {checked && <Check size={15} />}
          </label>
        );
      })}
    </div>
  );
}

function ModuleSettingsFields({
  selectedProducts,
  productRegionIds,
  activeProduct,
  onProductsChange,
  onRegionIdsChange,
  onActiveProductChange,
  initialFocus = false,
  showRegionPlaceholder = false,
}: {
  selectedProducts: readonly ConfigurableProduct[];
  productRegionIds: ProductRegionIds;
  activeProduct: ConfigurableProduct;
  onProductsChange: (products: ConfigurableProduct[]) => void;
  onRegionIdsChange: (product: RegionalProduct, regionIds: string[]) => void;
  onActiveProductChange: (product: ConfigurableProduct) => void;
  initialFocus?: boolean;
  showRegionPlaceholder?: boolean;
}) {
  const activeProductEnabled = selectedProducts.includes(activeProduct);
  const activeRegionalProduct = isRegionalProduct(activeProduct)
    && activeProductEnabled
    ? activeProduct
    : null;
  const regionPlaceholder = showRegionPlaceholder && !activeRegionalProduct
    ? activeProductEnabled
      ? {
          summary: "全局服务",
          title: "无需配置地域",
          description: `${productLabel(activeProduct)} 为全局服务。`,
        }
      : {
          summary: "模块未启用",
          title: "模块未启用",
          description: isRegionalProduct(activeProduct)
            ? `启用 ${productLabel(activeProduct)} 后可选择地域。`
            : `启用 ${productLabel(activeProduct)} 后可使用全局服务。`,
        }
    : null;

  const toggleProduct = (product: ConfigurableProduct, enabled: boolean) => {
    const products = enabled
      ? [...selectedProducts, product]
      : selectedProducts.filter((candidate) => candidate !== product);
    if (
      enabled
      && isRegionalProduct(product)
      && productRegionIds[product].length === 0
    ) {
      const defaultRegionId = getProductRegionIds(product, REGIONS.map((region) => region.id))[0];
      if (defaultRegionId) onRegionIdsChange(product, [defaultRegionId]);
    }
    onProductsChange([...new Set(products)]);
  };

  return (
    <>
      <div className="field-group">
        <span className="field-label">产品模块</span>
        <ProductSelector
          selected={selectedProducts}
          productRegionIds={productRegionIds}
          activeProduct={activeProduct}
          onActivate={onActiveProductChange}
          onToggle={toggleProduct}
          initialFocus={initialFocus}
        />
      </div>
      {activeRegionalProduct && (
        <div
          className="module-region-settings"
          role="group"
          aria-label={`${productLabel(activeRegionalProduct)} 地域配置`}
        >
          <div className="module-region-header">
            <span className="field-label">地域配置</span>
            <span className="module-region-summary">
              {productLabel(activeRegionalProduct)} · {productRegionIds[activeRegionalProduct].length} 个已选
            </span>
          </div>
          <RegionSelector
            product={activeRegionalProduct}
            selected={productRegionIds[activeRegionalProduct]}
            onChange={(regionIds) => onRegionIdsChange(activeRegionalProduct, regionIds)}
          />
        </div>
      )}
      {regionPlaceholder && (
        <div
          className="module-region-settings module-region-empty"
          role="status"
          aria-live="polite"
          aria-label={`${productLabel(activeProduct)} 地域配置状态`}
        >
          <div className="module-region-header">
            <span className="field-label">地域配置</span>
            <span className="module-region-summary">{regionPlaceholder.summary}</span>
          </div>
          <div className="module-region-empty-state">
            {activeProductEnabled
              ? <Globe2 size={20} aria-hidden="true" />
              : <CircleAlert size={20} aria-hidden="true" />}
            <div>
              <strong>{regionPlaceholder.title}</strong>
              <span>{regionPlaceholder.description}</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function findProductWithoutRegions(
  selectedProducts: readonly ConfigurableProduct[],
  productRegionIds: ProductRegionIds,
): RegionalProduct | undefined {
  return REGIONAL_PRODUCTS.find((product) =>
    selectedProducts.includes(product) && productRegionIds[product].length === 0);
}

export function Onboarding() {
  const snapshot = useRendererStore((state) => state.snapshot);
  const [selectedProducts, setSelectedProducts] = useState<ConfigurableProduct[]>(snapshot?.selectedProducts ?? [...PRODUCTS]);
  const [productRegionIds, setProductRegionIds] = useState<ProductRegionIds>(snapshot?.productRegionIds ?? {
    ack: ["cn-beijing"],
    kafka: ["cn-beijing"],
    mse: ["cn-beijing"],
  });
  const [activeProduct, setActiveProduct] = useState<ConfigurableProduct>(
    selectedProducts[0] ?? "ack",
  );
  const [product, setProduct] = useState<ConfigurableProduct>(selectedProducts[0] ?? "ack");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const productWithoutRegions = findProductWithoutRegions(selectedProducts, productRegionIds);

  const submit = async () => {
    if (productWithoutRegions || selectedProducts.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.opsdock.dispatch({
        type: "complete-onboarding",
        selectedProducts,
        productRegionIds,
        initialProduct: product,
      });
      if (!result.ok) setError(result.error);
    } catch {
      setError("初始化失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="onboarding">
      <div className="onboarding-panel">
        <div className="brand-mark"><Cloud size={21} /></div>
        <h1>CloudDock</h1>
        <p>选择需要的产品模块、地域和首次打开的控制台。</p>
        <ModuleSettingsFields
          selectedProducts={selectedProducts}
          productRegionIds={productRegionIds}
          activeProduct={activeProduct}
          onProductsChange={(products) => {
            setSelectedProducts(products);
            if (!products.includes(product) && products[0]) setProduct(products[0]);
          }}
          onRegionIdsChange={(regionalProduct, regionIds) => setProductRegionIds((current) => ({
            ...current,
            [regionalProduct]: regionIds,
          }))}
          onActiveProductChange={setActiveProduct}
        />
        <div className="field-group">
          <span className="field-label">首次打开</span>
          <div className="segmented-control">
            {selectedProducts.map((candidate) => (
              <button data-product={candidate} key={candidate} aria-pressed={product === candidate} className={product === candidate ? "active" : ""} onClick={() => setProduct(candidate)}>
                <ProductIcon product={candidate} /> {productLabel(candidate)}
              </button>
            ))}
          </div>
        </div>
        {productWithoutRegions && (
          <p className="form-error" role="alert">
            请为 {productLabel(productWithoutRegions)} 选择至少一个地域
          </p>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button" disabled={Boolean(productWithoutRegions) || selectedProducts.length === 0 || busy} onClick={submit}>
          {busy ? <LoaderCircle className="spin" size={17} /> : <ChevronRight size={17} />}
          开始使用
        </button>
      </div>
    </div>
  );
}

export function ProductSettingsModal() {
  const snapshot = useRendererStore((state) => state.snapshot)!;
  const setOpen = useRendererStore((state) => state.setProductSettingsOpen);
  const [selectedProducts, setSelectedProducts] = useState<ConfigurableProduct[]>(snapshot.selectedProducts);
  const [productRegionIds, setProductRegionIds] = useState<ProductRegionIds>(snapshot.productRegionIds);
  const [activeProduct, setActiveProduct] = useState<ConfigurableProduct>(
    snapshot.selectedProducts[0] ?? "ack",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const productWithoutRegions = findProductWithoutRegions(selectedProducts, productRegionIds);

  const save = async () => {
    if (busy || selectedProducts.length === 0 || productWithoutRegions) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.opsdock.dispatch({
        type: "set-module-settings",
        selectedProducts,
        productRegionIds,
      });
      if (result.ok) setOpen(false);
      else setError(result.error);
    } catch {
      setError("模块配置保存失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="管理模块"
      className="module-settings-modal"
      onClose={() => !busy && setOpen(false)}
      width={620}
    >
      <div className="modal-body">
        <ModuleSettingsFields
          selectedProducts={selectedProducts}
          productRegionIds={productRegionIds}
          activeProduct={activeProduct}
          onProductsChange={setSelectedProducts}
          onRegionIdsChange={(regionalProduct, regionIds) => setProductRegionIds((current) => ({
            ...current,
            [regionalProduct]: regionIds,
          }))}
          onActiveProductChange={setActiveProduct}
          initialFocus
          showRegionPlaceholder
        />
        {productWithoutRegions && (
          <p className="form-error" role="alert">
            请为 {productLabel(productWithoutRegions)} 选择至少一个地域
          </p>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <footer className="modal-actions">
        <button className="secondary-button" disabled={busy} onClick={() => setOpen(false)}>取消</button>
        <button className="primary-button small" disabled={selectedProducts.length === 0 || Boolean(productWithoutRegions) || busy} onClick={save}>
          {busy && <LoaderCircle className="spin" size={15} />}保存
        </button>
      </footer>
    </Modal>
  );
}
