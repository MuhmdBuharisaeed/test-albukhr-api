
#!/usr/bin/env python3
"""Patch the Testnet staking router only. Creates a timestamped backup."""
from pathlib import Path
from datetime import datetime

PATH = Path("testnet-staking-router.js")

if not PATH.exists():
    raise SystemExit(
        "ERROR: Run this from the Testnet API repository root; "
        "testnet-staking-router.js was not found."
    )

original = PATH.read_text(encoding="utf-8")
content = original

if 'router.post("/admin/project-stages/set"' in content:
    print("No changes: stage endpoints are already present.")
    raise SystemExit(0)

status_needle = "STAKING_POLICY_PROJECT_SCOPE_REQUIRED: 403,\n"
if status_needle not in content:
    raise SystemExit(
        "ERROR: API status mapping anchor not found; no file changed."
    )

status_add = status_needle + """      TESTNET_PROJECT_STAGE_SUPER_ADMIN_REQUIRED: 403,
      TESTNET_PROJECT_STAKING_STAGE_INVALID: 400,
      TESTNET_PROJECT_STAGE_FIELDS_REQUIRED: 400,
      TESTNET_PROJECT_STAGE_CHANGE_BLOCKED_PENDING_STAKE_INTENTS: 409,
      TESTNET_PROJECT_STAGE_CAP_BELOW_OUTSTANDING_PRINCIPAL: 409,
      GLOBAL_STAKING_STAGE_POLICY_NOT_CONFIGURED: 409,
      TESTNET_PROJECT_STAGE_LIST_FAILED: 500,
      TESTNET_PROJECT_STAGE_UPDATE_FAILED: 500,
"""
content = content.replace(status_needle, status_add, 1)

message_needle = "STAKING_POLICY_PROJECT_SCOPE_REQUIRED:\n"
if message_needle not in content:
    raise SystemExit(
        "ERROR: Friendly-message mapping anchor not found; no file changed."
    )

message_add = """TESTNET_PROJECT_STAGE_SUPER_ADMIN_REQUIRED:
        "Only a Testnet Super Admin can assign a project's staking stage.",
      TESTNET_PROJECT_STAKING_STAGE_INVALID:
        "Choose one of the approved Testnet project stages.",
      TESTNET_PROJECT_STAGE_FIELDS_REQUIRED:
        "Project, stage, and admin identity are required.",
      TESTNET_PROJECT_STAGE_CHANGE_BLOCKED_PENDING_STAKE_INTENTS:
        "The stage cannot change while a staking payment intent is pending.",
      TESTNET_PROJECT_STAGE_CAP_BELOW_OUTSTANDING_PRINCIPAL:
        "The new stage's staking cap is below outstanding principal.",
      GLOBAL_STAKING_STAGE_POLICY_NOT_CONFIGURED:
        "The central Testnet stage policy is not configured.",
      TESTNET_PROJECT_STAGE_LIST_FAILED:
        "Approved Testnet projects could not be loaded.",
      TESTNET_PROJECT_STAGE_UPDATE_FAILED:
        "The project stage could not be updated.",
      STAKING_POLICY_PROJECT_SCOPE_REQUIRED:
"""
content = content.replace(message_needle, message_add, 1)

route_needle = (
    '// Read the current Testnet policy.\n'
    'router.post("/admin/policy", async (req, res) => {'
)

if route_needle not in content:
    raise SystemExit(
        "ERROR: Admin policy route anchor not found; no file changed."
    )

routes = r'''// List approved Testnet projects for stage management.
// Super Admin only.
router.post("/admin/project-stages", async (req, res) => {
  try {
    const adminSession = await getTestnetAdminSession(req);

    if (!(adminSession.roles || []).includes("super_admin")) {
      throw new Error("TESTNET_PROJECT_STAGE_SUPER_ADMIN_REQUIRED");
    }

    const { data: projects, error: projectError } = await supabase
      .from("projects")
      .select("id,project_code,name,status,staking_stage")
      .eq("network", NETWORK)
      .eq("status", "approved")
      .order("project_code", { ascending: true });

    if (projectError || !Array.isArray(projects)) {
      throw new Error("TESTNET_PROJECT_STAGE_LIST_FAILED");
    }

    const ids = projects.map(p => p.id).filter(Boolean);
    let treasuryRows = [];

    if (ids.length) {
      const { data, error } = await supabase
        .from("project_treasury")
        .select(
          "project_id,verified_liquidity,required_liquidity,status"
        )
        .eq("network", NETWORK)
        .in("project_id", ids);

      if (error || !Array.isArray(data)) {
        throw new Error("TESTNET_PROJECT_STAGE_LIST_FAILED");
      }
      treasuryRows = data;
    }

    const treasuryByProject = new Map(
      treasuryRows.map(row => [clean(row.project_id), row])
    );

    return res.json({
      success: true,
      network: NETWORK,
      allowed_stages: [
        {
          value: "setup_pre_operation",
          label: "Setup / Pre-operation"
        },
        {
          value: "construction_fit_out",
          label: "Construction / Fit-out"
        },
        {
          value: "operating_expansion",
          label: "Operating / Expansion"
        }
      ],
      projects: projects.map(project => {
        const treasury =
          treasuryByProject.get(clean(project.id)) || null;

        return {
          id: project.id,
          project_code: project.project_code,
          name: project.name,
          staking_stage: project.staking_stage || null,
          treasury_status: treasury ? treasury.status : null,
          verified_liquidity: treasury
            ? Number(treasury.verified_liquidity || 0) : 0,
          required_liquidity: treasury
            ? Number(treasury.required_liquidity || 0) : 0
        };
      })
    });
  } catch (error) {
    console.error(
      "[TESTNET ADMIN PROJECT STAGES READ]",
      clean(error && error.message)
    );
    return apiError(res, error);
  }
});

// Assign a stage through the restricted Testnet database RPC.
router.post("/admin/project-stages/set", async (req, res) => {
  try {
    const adminSession = await getTestnetAdminSession(req);

    if (!(adminSession.roles || []).includes("super_admin")) {
      throw new Error("TESTNET_PROJECT_STAGE_SUPER_ADMIN_REQUIRED");
    }

    const project = await getApprovedProject(
      req.body && req.body.projectId,
      req.body && req.body.projectCode
    );

    const stage = clean(req.body && req.body.stakingStage);
    const allowedStages = [
      "setup_pre_operation",
      "construction_fit_out",
      "operating_expansion"
    ];

    if (!allowedStages.includes(stage)) {
      throw new Error("TESTNET_PROJECT_STAKING_STAGE_INVALID");
    }

    const actorId = clean(adminSession.admin_user_id);
    if (!actorId) {
      throw new Error("TESTNET_PROJECT_STAGE_FIELDS_REQUIRED");
    }

    const { data, error } = await supabase.rpc(
      "set_testnet_project_staking_stage",
      {
        p_project_id: project.id,
        p_staking_stage: stage,
        p_admin_actor_id: actorId
      }
    );

    if (error) {
      const message = clean(error.message);
      const known = [
        "TESTNET_PROJECT_STAGE_FIELDS_REQUIRED",
        "TESTNET_PROJECT_STAKING_STAGE_INVALID",
        "TESTNET_APPROVED_PROJECT_REQUIRED",
        "TESTNET_PROJECT_STAGE_CHANGE_BLOCKED_PENDING_STAKE_INTENTS",
        "GLOBAL_TESTNET_POLICY_NOT_CONFIGURED",
        "GLOBAL_STAKING_STAGE_POLICY_NOT_CONFIGURED",
        "GLOBAL_STAKING_STAGE_POLICY_INVALID",
        "TESTNET_STAKING_COVERAGE_UNAVAILABLE",
        "TESTNET_PROJECT_STAGE_CAP_BELOW_OUTSTANDING_PRINCIPAL",
        "TESTNET_PROJECT_STAGE_RPC_REQUIRED"
      ];

      const matched = known.find(code => message.includes(code));
      if (matched) throw new Error(matched);
      throw new Error("TESTNET_PROJECT_STAGE_UPDATE_FAILED");
    }

    if (!data || data.success !== true) {
      throw new Error("TESTNET_PROJECT_STAGE_UPDATE_FAILED");
    }

    return res.json({
      success: true,
      network: NETWORK,
      project: {
        id: project.id,
        project_code: project.project_code,
        name: project.name
      },
      staking_stage: data.staking_stage,
      changed: data.changed === true
    });
  } catch (error) {
    console.error(
      "[TESTNET ADMIN PROJECT STAGE SET]",
      clean(error && error.message)
    );
    return apiError(res, error);
  }
});

// Read the current Testnet policy.
router.post("/admin/policy", async (req, res) => {'''

routes = routes.replace(r'\"', '"')
content = content.replace(route_needle, routes, 1)

backup = PATH.with_suffix(
    PATH.suffix + ".bak." + datetime.utcnow().strftime("%Y%m%d%H%M%S")
)
backup.write_text(original, encoding="utf-8")
PATH.write_text(content, encoding="utf-8")

print(f"Updated {PATH}")
print(f"Original backup: {backup}")
