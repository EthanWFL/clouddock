export interface RegionOption {
  id: string;
  name: string;
  shortName: string;
}

export const REGIONS: readonly RegionOption[] = [
  { id: "cn-beijing", name: "华北 2（北京）", shortName: "北京" },
  { id: "cn-zhangjiakou", name: "华北 3（张家口）", shortName: "张家口" },
  { id: "cn-huhehaote", name: "华北 5（呼和浩特）", shortName: "呼和浩特" },
  { id: "cn-wulanchabu", name: "华北 6（乌兰察布）", shortName: "乌兰察布" },
  { id: "cn-hangzhou", name: "华东 1（杭州）", shortName: "杭州" },
  { id: "cn-shanghai", name: "华东 2（上海）", shortName: "上海" },
  { id: "cn-nanjing", name: "华东 5（南京-本地地域）", shortName: "南京" },
  { id: "cn-shenzhen", name: "华南 1（深圳）", shortName: "深圳" },
  { id: "cn-heyuan", name: "华南 2（河源）", shortName: "河源" },
  { id: "cn-guangzhou", name: "华南 3（广州）", shortName: "广州" },
  { id: "cn-chengdu", name: "西南 1（成都）", shortName: "成都" },
  { id: "cn-hongkong", name: "中国香港", shortName: "香港" },
] as const;

export const DEFAULT_REGION_IDS = ["cn-beijing"] as const;

export function findRegion(regionId: string): RegionOption | undefined {
  return REGIONS.find((region) => region.id === regionId);
}

export function getRegionShortName(regionId: string): string {
  return findRegion(regionId)?.shortName ?? regionId;
}

export function isKnownRegion(regionId: string): boolean {
  return REGIONS.some((region) => region.id === regionId);
}
