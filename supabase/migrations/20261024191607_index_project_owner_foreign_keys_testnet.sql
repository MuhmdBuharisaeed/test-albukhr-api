CREATE INDEX IF NOT EXISTS idx_project_owner_history_previous_owner_user_id
  ON public.project_owner_history (previous_owner_user_id);

CREATE INDEX IF NOT EXISTS idx_project_owner_history_new_owner_user_id
  ON public.project_owner_history (new_owner_user_id);

CREATE INDEX IF NOT EXISTS idx_project_owner_profiles_owner_user_id
  ON public.project_owner_profiles (owner_user_id);
