"""Export synthetic simulations, or explicitly submit them to an unbound draft.

--submit uses paid Retell text inference, never phone calls. Every external tool
must have a nonempty catch-all mock. Production/published agents are refused.
"""
import argparse
import json
import os
from pathlib import Path

from prepare import request
from tests.scenarios import cases


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--output-dir", required=True)
    p.add_argument("--agent-id")
    p.add_argument("--submit", action="store_true")
    args = p.parse_args()
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    definitions = cases()
    (output / "cases.json").write_text(json.dumps(definitions, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if not args.submit:
        print("Exported scenarios locally. Use --submit --agent-id to run paid mocked text simulations.")
        return
    if not args.agent_id or not args.agent_id.startswith("agent_"):
        p.error("--agent-id required")
    if (output / "retell-tests.json").exists():
        p.error("Test submission already recorded in this output directory")
    def api(path, body=None):
        return request("https://api.retellai.com/" + path, os.environ["RETELL_API_KEY"], body)
    agent = api("get-agent/" + args.agent_id)
    if agent.get("is_published") or not agent["agent_name"].startswith("Apero Master Clinic Template"):
        p.error("Only the separate, unpublished Apero master is allowed")
    engine = agent["response_engine"]
    if engine["type"] != "conversation-flow":
        p.error("Expected conversation flow")
    flow = api("get-conversation-flow/" + engine["conversation_flow_id"] + f"?version={engine['version']}")
    names = {t["name"] for t in flow["tools"]}
    for case in definitions:
        mocked = {m["tool_name"] for m in case["tool_mocks"] if m["input_match_rule"]["type"] == "any" and m["output"]}
        if names != mocked:
            p.error("Every external tool must be mocked; refusing submission")
    ids = []
    record = {"agent_id": args.agent_id, "response_engine": engine, "cases": ids}
    def save():
        (output / "retell-tests.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    save()
    for case in definitions:
        result = api("create-test-case-definition", {**case, "response_engine": engine})
        ids.append({"name": case["name"], "id": result["test_case_definition_id"]})
        save()
    record["batch"] = api("create-batch-test", {"response_engine": engine, "test_case_definition_ids": [v["id"] for v in ids]})
    save()
    print("Submitted mocked text batch:", record["batch"]["test_case_batch_job_id"])
    print("Review in Retell Simulation / Batch Testing History; do not treat LLM grades as proof without transcript review.")


if __name__ == "__main__": main()
