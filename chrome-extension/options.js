import { loadRules, normalizeRule, saveRules } from "./rules.js";

const form = document.querySelector("#rule-form");
const hostInput = document.querySelector("#host");
const pathInput = document.querySelector("#path");
const list = document.querySelector("#rules");
const empty = document.querySelector("#empty");
const message = document.querySelector("#message");

let rules = [];

function setMessage(value, success = false) {
  message.textContent = value;
  message.classList.toggle("success", success);
}

function createRuleRow(rule) {
  const item = document.createElement("li");
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.checked = rule.enabled;
  enabled.setAttribute("aria-label", `启用 ${rule.host}${rule.pathPrefix}`);
  enabled.addEventListener("change", async () => {
    rules = await saveRules(rules.map((candidate) => (
      candidate.id === rule.id ? { ...candidate, enabled: enabled.checked } : candidate
    )));
    render();
  });

  const text = document.createElement("code");
  text.textContent = `https://${rule.host}${rule.pathPrefix}`;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.textContent = "删除";
  remove.addEventListener("click", async () => {
    rules = await saveRules(rules.filter((candidate) => candidate.id !== rule.id));
    render();
  });

  item.append(enabled, text, remove);
  return item;
}

function render() {
  list.replaceChildren(...rules.map(createRuleRow));
  empty.hidden = rules.length > 0;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const rule = normalizeRule({
      id: crypto.randomUUID(),
      enabled: true,
      host: hostInput.value,
      pathPrefix: pathInput.value,
    });
    rules = await saveRules([...rules, rule]);
    form.reset();
    pathInput.value = "/";
    setMessage("规则已保存", true);
    render();
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "规则无效");
  }
});

void loadRules().then((storedRules) => {
  rules = storedRules;
  render();
});
