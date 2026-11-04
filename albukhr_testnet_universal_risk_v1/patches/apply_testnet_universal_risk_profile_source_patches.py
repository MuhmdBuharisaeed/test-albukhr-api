#!/usr/bin/env python3
"""Apply minimal, exact-context ALBUKHR Testnet universal-risk source patches.

The >1,000-line API router is patched in place; it is never replaced.
The two client scripts (<1,000 lines each) are patched minimally to preserve
all existing rendering, session, API, and event-handling behaviour.

Usage:
  python apply_testnet_universal_risk_profile_source_patches.py \
    --api-root /path/to/test-albukhr-api \
    --app-root /path/to/test-albukhr-app

The script validates every target and expected occurrence count before writing
any file. It creates a .pre-universal-risk-v1.bak beside each changed file.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import sys


def replace_exact(source: str, old: str, new: str, expected: int, label: str) -> str:
    actual = source.count(old)
    if actual != expected:
        raise RuntimeError(
            f"SOURCE_MISMATCH [{label}]: expected {expected} occurrence(s), found {actual}. "
            "No files have been written. Re-fetch the current source and reconcile manually."
        )
    return source.replace(old, new)


def patch_api(path: Path) -> str:
    source = path.read_text(encoding="utf-8")

    # getApprovedProject + getOwnedProject. The separate legacy admin stage list
    # endpoint intentionally continues to return staking_stage for compatibility.
    source = replace_exact(
        source,
        '.select("id,project_code,name,network,status,owner_user_id,staking_stage")',
        '.select("id,project_code,name,network,status,owner_user_id")',
        2,
        "API project helper stage select",
    )

    source = replace_exact(
        source,
        '"staking_reward_rates_by_duration,staking_stage_policies," +',
        '"staking_reward_rates_by_duration,staking_universal_risk_policy," +',
        1,
        "API global policy selected field",
    )

    old = '''    const stagePolicies =
      globalPolicy.staking_stage_policies &&
      typeof globalPolicy.staking_stage_policies === "object" &&
      !Array.isArray(globalPolicy.staking_stage_policies)
        ? globalPolicy.staking_stage_policies
        : {};

    const stageRule = project.staking_stage
      ? stagePolicies[project.staking_stage]
      : null;'''
    new = '''    const universalRiskPolicy =
      globalPolicy.staking_universal_risk_policy &&
      typeof globalPolicy.staking_universal_risk_policy === "object" &&
      !Array.isArray(globalPolicy.staking_universal_risk_policy)
        ? globalPolicy.staking_universal_risk_policy
        : null;'''
    source = replace_exact(source, old, new, 1, "API owner policy profile read")

    old = '''    const stageCapitalReserve = numberOrNull(
      stageRule && stageRule.capital_reserve_percent
    );

    const stageMaximumDeployment = numberOrNull(
      stageRule && stageRule.maximum_deployment_percent
    );

    const stageMaximumPrincipal = numberOrNull(
      stageRule && stageRule.max_active_principal
    );

    const stageRuleReady =
      !!stageRule &&
      stageCapitalReserve !== null &&
      stageMaximumDeployment !== null &&
      stageMaximumPrincipal !== null &&
      stageCapitalReserve >= 0 &&
      stageCapitalReserve <= 100 &&
      stageMaximumDeployment >= 0 &&
      stageMaximumDeployment <= 100 &&
      stageCapitalReserve + stageMaximumDeployment <= 100 &&
      stageMaximumPrincipal > 0;'''
    new = '''    const riskCapitalReserve = numberOrNull(
      universalRiskPolicy && universalRiskPolicy.capital_reserve_percent
    );

    const riskMaximumDeployment = numberOrNull(
      universalRiskPolicy && universalRiskPolicy.maximum_deployment_percent
    );

    const riskMaximumPrincipal = numberOrNull(
      universalRiskPolicy && universalRiskPolicy.max_active_principal
    );

    // These are the globally approved Testnet risk limits. The database
    // validator independently enforces the same exact values.
    const universalRiskPolicyReady =
      riskCapitalReserve === 50 &&
      riskMaximumDeployment === 25 &&
      riskMaximumPrincipal === 100;'''
    source = replace_exact(source, old, new, 1, "API universal risk values")

    old = '''      control.approval_status === "approved" &&
      stageRuleReady &&
      treasuryReady &&
      globalMaximumRewardRate !== null &&
      sameNumber(
        controlMinimumLiquidity,
        expectedMinimumLiquidity
      ) &&
      sameNumber(
        controlCapitalReserve,
        stageCapitalReserve
      ) &&
      sameNumber(
        controlMaximumDeployment,
        stageMaximumDeployment
      ) &&
      sameNumber(
        controlMaximumPrincipal,
        stageMaximumPrincipal
      ) &&'''
    new = '''      control.approval_status === "approved" &&
      universalRiskPolicyReady &&
      treasuryReady &&
      globalMaximumRewardRate !== null &&
      sameNumber(
        controlMinimumLiquidity,
        expectedMinimumLiquidity
      ) &&
      sameNumber(
        controlCapitalReserve,
        riskCapitalReserve
      ) &&
      sameNumber(
        controlMaximumDeployment,
        riskMaximumDeployment
      ) &&
      sameNumber(
        controlMaximumPrincipal,
        riskMaximumPrincipal
      ) &&'''
    source = replace_exact(source, old, new, 1, "API approved controls comparison")

    old = '''    const effectiveCapitalReserve =
      stageRuleReady && controlCapitalReserve !== null
        ? Math.max(
            stageCapitalReserve,
            controlCapitalReserve
          )
        : null;

    const effectiveMaximumDeployment =
      stageRuleReady && controlMaximumDeployment !== null
        ? Math.min(
            stageMaximumDeployment,
            controlMaximumDeployment
          )
        : null;

    const effectiveMaximumPrincipal =
      stageRuleReady && controlMaximumPrincipal !== null
        ? Math.min(
            stageMaximumPrincipal,
            controlMaximumPrincipal
          )
        : null;'''
    new = '''    const effectiveCapitalReserve =
      universalRiskPolicyReady && controlCapitalReserve !== null
        ? Math.max(riskCapitalReserve, controlCapitalReserve)
        : null;

    const effectiveMaximumDeployment =
      universalRiskPolicyReady && controlMaximumDeployment !== null
        ? Math.min(riskMaximumDeployment, controlMaximumDeployment)
        : null;

    const effectiveMaximumPrincipal =
      universalRiskPolicyReady && controlMaximumPrincipal !== null
        ? Math.min(riskMaximumPrincipal, controlMaximumPrincipal)
        : null;'''
    source = replace_exact(source, old, new, 1, "API effective risk limits")

    source = replace_exact(
        source,
        '    } else if (!stageRuleReady) {\n      lockedReason = "PROJECT_STAKING_STAGE_NOT_CONFIGURED";',
        '    } else if (!universalRiskPolicyReady) {\n      lockedReason = "GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED";',
        1,
        "API locked reason",
    )

    # Remove stage-only data from the owner API response; the legacy stage
    # manager reads it from its own dedicated admin endpoint.
    source = replace_exact(
        source,
        '''      project: {
        id: project.id,
        project_code: project.project_code,
        name: project.name,
        staking_stage: project.staking_stage || null
      },''',
        '''      project: {
        id: project.id,
        project_code: project.project_code,
        name: project.name
      },''',
        1,
        "API owner project response stage field",
    )
    source = replace_exact(
        source,
        '        staking_stage:\n          project.staking_stage || null\n',
        '',
        1,
        "API owner preview stage field",
    )

    # New database error codes must be recognised and mapped to actionable HTTP responses.
    source = replace_exact(
        source,
        '  PROJECT_STAKING_STAGE_REQUIRED: 409,\n',
        '  PROJECT_STAKING_STAGE_REQUIRED: 409,\n  GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED: 409,\n  GLOBAL_UNIVERSAL_RISK_POLICY_INVALID: 400,\n  GLOBAL_UNIVERSAL_RISK_POLICY_MUST_MATCH_APPROVED_LIMITS: 400,\n',
        1,
        "API universal risk HTTP status codes",
    )
    source = replace_exact(
        source,
        '''PROJECT_STAKING_STAGE_REQUIRED:
  "Assign an approved staking stage before provisioning risk controls.",''',
        '''PROJECT_STAKING_STAGE_REQUIRED:
  "This legacy stage operation is no longer required for Testnet risk provisioning.",

GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED:
  "The universal Testnet risk policy is missing or incomplete.",
GLOBAL_UNIVERSAL_RISK_POLICY_INVALID:
  "The universal Testnet risk policy failed validation.",
GLOBAL_UNIVERSAL_RISK_POLICY_MUST_MATCH_APPROVED_LIMITS:
  "The universal Testnet risk policy must remain at 50% reserve, 25% deployment and 100 PI active principal.",''',
        1,
        "API universal risk friendly messages",
    )

    # Provision / offer error translation. Keep stage-related API messages for
    # the legacy stage endpoints, but map the new risk RPC error explicitly.
    source = replace_exact(
        source,
        '''      if (message.includes("PROJECT_STAKING_STAGE_REQUIRED"))
        throw new Error("PROJECT_STAKING_STAGE_REQUIRED");''',
        '''      if (message.includes("GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED"))
        throw new Error("GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED");''',
        1,
        "API provisioning error translation",
    )
    source = replace_exact(
        source,
        '''        if (message.includes("PROJECT_STAKING_STAGE_REQUIRED")) throw new Error("PROJECT_STAKING_STAGE_REQUIRED");''',
        '''        if (message.includes("GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED")) throw new Error("GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED");''',
        1,
        "API owner offer error translation",
    )

    return source


def patch_risk_admin(path: Path) -> str:
    source = path.read_text(encoding="utf-8")
    source = replace_exact(
        source,
        '"Review the stage and treasury first. Provisioning creates pending controls only. A separate Super Admin decision is required; approval does not enable staking."',
        '"Testnet uses one universal Testnet risk profile for every Mainnet-approved project. Provisioning creates pending controls only. A separate Super Admin decision is required; approval does not enable staking."',
        1,
        "Risk Admin explanatory text",
    )
    source = replace_exact(
        source,
        '''  function stageLabel(value) {
    return ({
      setup_pre_operation: "Setup / Pre-operation",
      construction_fit_out: "Construction / Fit-out",
      operating_expansion: "Operating / Expansion"
    })[clean(value)] || "Not assigned";
  }

''',
        '',
        1,
        "Risk Admin stage label helper",
    )
    source = replace_exact(
        source,
        '      clean(project.staking_stage) &&\n',
        '',
        1,
        "Risk Admin provisioning stage gate",
    )
    source = replace_exact(
        source,
        '    field(grid, "Business stage", stageLabel(project.staking_stage));',
        '    field(grid, "Testnet risk profile", "Universal · 50% reserve / 25% deployment / 100 PI cap");',
        1,
        "Risk Admin stage display",
    )
    source = replace_exact(
        source,
        '''          " using the current approved stage policy? This does not approve the controls or enable staking."''',
        '''          " using the universal Testnet risk policy (50% reserve, 25% deployment, 100 PI cap)? This creates pending controls only and does not enable staking."''',
        1,
        "Risk Admin confirmation text",
    )
    source = replace_exact(
        source,
        '''      if (!project.staking_stage) {
        card.appendChild(
          create(
            "p",
            "risk-warning",
            "Assign the correct business lifecycle stage in the Stage Manager before provisioning."
          )
        );
      } else if (
        clean(project.treasury_status).toLowerCase() !== "active" ||
        !(Number(project.required_liquidity) > 0)
      ) {''',
        '''      if (
        clean(project.treasury_status).toLowerCase() !== "active" ||
        !(Number(project.required_liquidity) > 0)
      ) {''',
        1,
        "Risk Admin remove stage warning",
    )
    return source


def patch_owner(path: Path) -> str:
    source = path.read_text(encoding="utf-8")
    source = replace_exact(
        source,
        '    appendLine(node, "Current staking stage: " + (clean(preview.staking_stage) || "Not assigned"));\n',
        '',
        1,
        "Owner panel remove stage status",
    )
    source = replace_exact(
        source,
        '      notes.push("ALBUKHR Admin must assign a staking stage and provision this project\'s risk controls before you can configure offers.");',
        '      notes.push("ALBUKHR Super Admin must provision and approve this project\'s universal Testnet risk controls before you can configure offers.");',
        1,
        "Owner panel stage instruction",
    )
    return source


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-root", required=True, type=Path)
    parser.add_argument("--app-root", required=True, type=Path)
    args = parser.parse_args()

    targets = [
        (args.api_root / "testnet-staking-router.js", patch_api),
        (args.app_root / "js/testnet-project-staking-risk-admin.js", patch_risk_admin),
        (args.app_root / "js/testnet-owner-staking.js", patch_owner),
    ]

    # Prepare and validate every file in memory first; fail before writing any file.
    prepared: list[tuple[Path, str, str]] = []
    for path, patcher in targets:
        if not path.is_file():
            raise FileNotFoundError(f"Required source file not found: {path}")
        original = path.read_text(encoding="utf-8")
        line_count = len(original.splitlines())
        if path.name == "testnet-staking-router.js" and line_count <= 1000:
            raise RuntimeError(f"Expected a >1,000-line API file for patch-only handling, got {line_count}: {path}")
        if path.name in ("testnet-project-staking-risk-admin.js", "testnet-owner-staking.js") and line_count >= 1000:
            raise RuntimeError(f"Expected a <1,000-line client file for this minimal patch, got {line_count}: {path}")
        patched = patcher(path)
        if patched == original:
            raise RuntimeError(f"No patch changes detected for {path}")
        prepared.append((path, original, patched))

    for path, original, patched in prepared:
        backup = path.with_name(path.name + ".pre-universal-risk-v1.bak")
        if backup.exists():
            raise FileExistsError(
                f"Backup already exists: {backup}. Preserve it and inspect before retrying."
            )
        backup.write_text(original, encoding="utf-8", newline="")
        path.write_text(patched, encoding="utf-8", newline="")

    print("PASS: patched all three files after exact-context validation")
    for path, _, _ in prepared:
        print(f"PATCHED: {path}")
        print(f"BACKUP:  {path.name}.pre-universal-risk-v1.bak")
    print("The API router was patched in place; no file was replaced wholesale.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"PATCH_ABORTED: {exc}", file=sys.stderr)
        raise SystemExit(2)
