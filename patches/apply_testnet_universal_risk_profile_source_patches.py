#!/usr/bin/env python3
"""Apply minimal, fail-closed ALBUKHR Testnet universal-risk source patches.

The 2,000+ line API router is patched in place; it is never replaced wholesale.
All five target files are read and validated before any write. All backup paths
are checked before writing. Source writes are atomic and originals are restored
if a write fails part-way through.

Run:
  python3 apply_testnet_universal_risk_profile_source_patches.py \
    --api-root /path/to/test-albukhr-api \
    --app-root /path/to/test-albukhr-app

This changes source files only. It does not call Supabase, make payments, enable
project staking, enable global staking, or deploy anything.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import stat
import sys
import tempfile

BACKUP_SUFFIX = ".pre-universal-risk-v1.bak"


def replace_exact(source: str, old: str, new: str, expected: int, label: str) -> str:
    actual = source.count(old)
    if actual != expected:
        raise RuntimeError(
            f"SOURCE_MISMATCH [{label}]: expected {expected} occurrence(s), "
            f"found {actual}. No files have been written. Re-fetch current "
            "source and reconcile manually."
        )
    return source.replace(old, new)


def patch_api(path: Path) -> str:
    source = path.read_text(encoding="utf-8")

    # Owner project lookups only. The dedicated legacy stage-admin endpoint
    # intentionally retains its stage field for compatibility.
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

    # API errors from the universal policy must be surfaced accurately.
    source = replace_exact(
        source,
        '  PROJECT_STAKING_STAGE_REQUIRED: 409,\n',
        '  PROJECT_STAKING_STAGE_REQUIRED: 409,\n'
        '  GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED: 409,\n'
        '  GLOBAL_UNIVERSAL_RISK_POLICY_INVALID: 400,\n'
        '  GLOBAL_UNIVERSAL_RISK_POLICY_MUST_MATCH_APPROVED_LIMITS: 400,\n',
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

    # Provision endpoint: stage eligibility is replaced only here. The legacy
    # stage manager endpoint and its own validation remain untouched.
    source = replace_exact(
        source,
        '''      if (message.includes("PROJECT_STAKING_STAGE_REQUIRED"))
        throw new Error("PROJECT_STAKING_STAGE_REQUIRED");''',
        '''      if (message.includes("GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED"))
        throw new Error("GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED");
      if (message.includes("GLOBAL_UNIVERSAL_RISK_POLICY_INVALID"))
        throw new Error("GLOBAL_UNIVERSAL_RISK_POLICY_INVALID");
      if (message.includes("GLOBAL_UNIVERSAL_RISK_POLICY_MUST_MATCH_APPROVED_LIMITS"))
        throw new Error("GLOBAL_UNIVERSAL_RISK_POLICY_MUST_MATCH_APPROVED_LIMITS");''',
        1,
        "API provisioning universal-risk error translation",
    )
    source = replace_exact(
        source,
        '''        if (message.includes("PROJECT_STAKING_STAGE_REQUIRED")) throw new Error("PROJECT_STAKING_STAGE_REQUIRED");''',
        '''        if (message.includes("GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED")) throw new Error("GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED");
        if (message.includes("GLOBAL_UNIVERSAL_RISK_POLICY_INVALID")) throw new Error("GLOBAL_UNIVERSAL_RISK_POLICY_INVALID");
        if (message.includes("GLOBAL_UNIVERSAL_RISK_POLICY_MUST_MATCH_APPROVED_LIMITS")) throw new Error("GLOBAL_UNIVERSAL_RISK_POLICY_MUST_MATCH_APPROVED_LIMITS");''',
        1,
        "API owner offer universal-risk error translation",
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
        '''      notes.push("ALBUKHR Admin must assign a staking stage and provision this project's risk controls before you can configure offers.");''',
        '''      notes.push("ALBUKHR Super Admin must provision and approve this project's universal Testnet risk controls before you can configure offers.");''',
        1,
        "Owner panel stage instruction",
    )
    return source


def patch_admin_dashboard(path: Path) -> str:
    source = path.read_text(encoding="utf-8")
    return replace_exact(
        source,
        'js/testnet-project-staking-risk-admin.js?v=20261104-risk-admin2',
        'js/testnet-project-staking-risk-admin.js?v=20261104-universal-risk-v1',
        1,
        "Admin dashboard risk script cache version",
    )


def patch_owner_page(path: Path) -> str:
    source = path.read_text(encoding="utf-8")
    return replace_exact(
        source,
        'js/testnet-owner-staking.js?v=20261103-staking-v2',
        'js/testnet-owner-staking.js?v=20261104-universal-risk-v1',
        1,
        "Project owner staking script cache version",
    )


def atomic_write(path: Path, content: str, mode: int) -> None:
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_name, mode)
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-root", required=True, type=Path)
    parser.add_argument("--app-root", required=True, type=Path)
    args = parser.parse_args()

    api_root = args.api_root.resolve()
    app_root = args.app_root.resolve()
    targets = [
        (api_root / "testnet-staking-router.js", patch_api, "API router"),
        (app_root / "js/testnet-project-staking-risk-admin.js", patch_risk_admin, "Risk Admin UI"),
        (app_root / "js/testnet-owner-staking.js", patch_owner, "Owner staking UI"),
        (app_root / "admin-dashboard.html", patch_admin_dashboard, "Admin dashboard cache version"),
        (app_root / "project-owner.html", patch_owner_page, "Owner page cache version"),
    ]

    # Phase 1: read and validate every target entirely in memory.
    prepared: list[tuple[Path, str, str, int]] = []
    for path, patcher, label in targets:
        if not path.is_file():
            raise FileNotFoundError(f"Required {label} file not found: {path}")
        original = path.read_text(encoding="utf-8")
        lines = len(original.splitlines())
        if path.name == "testnet-staking-router.js" and lines <= 1000:
            raise RuntimeError(f"Expected >1,000-line API router; found {lines}: {path}")
        if path.name in ("testnet-project-staking-risk-admin.js", "testnet-owner-staking.js") and lines >= 1000:
            raise RuntimeError(f"Expected <1,000-line client file; found {lines}: {path}")
        patched = patcher(path)
        if patched == original:
            raise RuntimeError(f"No patch changes detected for {label}: {path}")
        mode = stat.S_IMODE(path.stat().st_mode)
        prepared.append((path, original, patched, mode))

    # Phase 2: ensure ALL backup paths are available before creating any.
    backups = [(path, path.with_name(path.name + BACKUP_SUFFIX)) for path, _, _, _ in prepared]
    collisions = [str(backup) for _, backup in backups if backup.exists()]
    if collisions:
        raise FileExistsError(
            "Existing backup(s) detected. No files were written; preserve and "
            "inspect them before retrying:\n  " + "\n  ".join(collisions)
        )

    # Phase 3: create every backup before altering any source.
    created_backups: list[Path] = []
    try:
        for (path, original, _, mode), (_, backup) in zip(prepared, backups):
            try:
                with backup.open("x", encoding="utf-8", newline="") as handle:
                    handle.write(original)
                    handle.flush()
                    os.fsync(handle.fileno())
            except Exception:
                try:
                    backup.unlink()
                except OSError:
                    pass
                raise
            created_backups.append(backup)
            os.chmod(backup, mode)
    except Exception:
        for backup in created_backups:
            try:
                backup.unlink()
            except OSError:
                pass
        raise

    # Phase 4: atomic source writes. If any write fails, restore ALL originals.
    try:
        for path, original, patched, mode in prepared:
            atomic_write(path, patched, mode)
    except Exception as write_error:
        restore_errors: list[str] = []
        for path, original, _, mode in prepared:
            try:
                atomic_write(path, original, mode)
            except Exception as restore_error:
                restore_errors.append(f"{path}: {restore_error}")
        if restore_errors:
            raise RuntimeError(
                f"Source write failed ({write_error}); one or more restore operations also failed: "
                + "; ".join(restore_errors)
                + ". Keep all .bak files and stop for manual recovery."
            ) from write_error
        raise RuntimeError(
            f"Source write failed ({write_error}); all original source contents were restored. "
            "Keep the generated backups for inspection."
        ) from write_error

    print("PASS: all five source targets were patched after exact-context validation")
    for path, _, _, _ in prepared:
        print(f"PATCHED: {path}")
        print(f"BACKUP:  {path.name}{BACKUP_SUFFIX}")
    print("The API router was patched in place; no source file was replaced wholesale.")
    print("No database, Pi payment, project enablement, global activation, or deployment action was performed.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"PATCH_ABORTED: {exc}", file=sys.stderr)
        raise SystemExit(2)
