import { getRecord, type QueryExecutor } from "./index.js";
import type { Environment } from "../../contracts/src/index.js";
import { buildSellerSnapshot } from "../../domain/src/sales/seller-context.js";
export async function loadSellerSnapshot(
  c: QueryExecutor,
  workspace: string,
  environment: Environment,
  offerId?: string,
  agentId?: string,
  asOf?: string,
) {
  const get = async (kind: string, id?: string) => {
    const r = id ? await getRecord(c, workspace, kind, id) : undefined;
    if (r && r.environment !== environment)
      throw new Error("SELLER_CONTEXT_SCOPE_MISMATCH");
    if (r && asOf && ["product", "category"].includes(kind)) {
      const version = (
        await c.query(
          "SELECT * FROM record_versions WHERE record_id=$1 AND workspace_id=$2 AND environment=$3 AND created_at<=$4 ORDER BY version DESC LIMIT 1",
          [r.id, workspace, environment, asOf],
        )
      ).rows[0];
      return version
        ? { ...r, version: version.version, body: version.body }
        : undefined;
    }
    return r;
  };
  const offer = await get("offer", offerId),
    product = await get("product", offer?.body.product_id),
    category = await get("category", product?.body.category_id),
    agent = await get("agent", agentId);
  return buildSellerSnapshot({ offer, product, category, agent });
}
