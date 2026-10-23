/**
 * Hallyu backend — database type contract.
 *
 * This file is the typed mirror of what supabase/migrations actually creates. It is hand-maintained
 * (there is no connected project to introspect yet) and `npm run test:dbtypes` proves it still matches
 * the SQL: the checker parses every migration and fails if a table or column is missing on either
 * side. When the backend is attached in the next phase, regenerate it with
 * `npx supabase gen types typescript --linked --project-id <id> > supabase/types/database.ts`.
 *
 * Nothing here is imported by the app yet — the frontend connects in the next phase — but the shape
 * is the contract the client will code against.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      app_releases: {
        Row: {
          apk_url: string;
          file_size_bytes: number | null;
          git_commit: string | null;
          id: string;
          is_mandatory: boolean;
          min_supported_version: number;
          published_at: string;
          release_notes: string;
          sha256: string | null;
          universal_apk_url: string | null;
          version_code: number;
          version_name: string;
        };
        Insert: {
          apk_url: string;
          file_size_bytes?: number | null;
          git_commit?: string | null;
          id?: string;
          is_mandatory?: boolean;
          min_supported_version?: number;
          published_at?: string;
          release_notes?: string;
          sha256?: string | null;
          universal_apk_url?: string | null;
          version_code: number;
          version_name: string;
        };
        Update: {
          apk_url?: string;
          file_size_bytes?: number | null;
          git_commit?: string | null;
          id?: string;
          is_mandatory?: boolean;
          min_supported_version?: number;
          published_at?: string;
          release_notes?: string;
          sha256?: string | null;
          universal_apk_url?: string | null;
          version_code?: number;
          version_name?: string;
        };
        Relationships: [];
      };
      ci_build_vault: {
        Row: {
          key: string;
          updated_at: string;
          value: string;
        };
        Insert: {
          key: string;
          updated_at?: string;
          value: string;
        };
        Update: {
          key?: string;
          updated_at?: string;
          value?: string;
        };
        Relationships: [];
      };
      hallyu_event_rsvps: {
        Row: {
          created_at: string;
          event_id: string;
          prediction_choice: number | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          event_id: string;
          prediction_choice?: number | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          event_id?: string;
          prediction_choice?: number | null;
          user_id?: string;
        };
        Relationships: [];
      };
      hallyu_events: {
        Row: {
          cover_url: string | null;
          created_at: string;
          description: string;
          ends_at: string;
          episode: number | null;
          event_kind: string;
          host_id: string | null;
          id: string;
          is_featured: boolean;
          prediction_options: Json;
          prediction_question: string | null;
          rsvp_count: number;
          season: number | null;
          starts_at: string;
          subtitle: string | null;
          title: string;
          title_id: string | null;
          world: string;
        };
        Insert: {
          cover_url?: string | null;
          created_at?: string;
          description?: string;
          ends_at: string;
          episode?: number | null;
          event_kind?: string;
          host_id?: string | null;
          id?: string;
          is_featured?: boolean;
          prediction_options?: Json;
          prediction_question?: string | null;
          rsvp_count?: number;
          season?: number | null;
          starts_at: string;
          subtitle?: string | null;
          title: string;
          title_id?: string | null;
          world?: string;
        };
        Update: {
          cover_url?: string | null;
          created_at?: string;
          description?: string;
          ends_at?: string;
          episode?: number | null;
          event_kind?: string;
          host_id?: string | null;
          id?: string;
          is_featured?: boolean;
          prediction_options?: Json;
          prediction_question?: string | null;
          rsvp_count?: number;
          season?: number | null;
          starts_at?: string;
          subtitle?: string | null;
          title?: string;
          title_id?: string | null;
          world?: string;
        };
        Relationships: [];
      };
      support_tickets: {
        Row: {
          app_version: string | null;
          category: string;
          created_at: string;
          description: string;
          diagnostics: Json;
          id: string;
          platform: string | null;
          reporter_email: string | null;
          reporter_id: string | null;
          route_name: string | null;
          screenshot_url: string | null;
          staff_note: string | null;
          status: string;
          subject: string;
          updated_at: string;
        };
        Insert: {
          app_version?: string | null;
          category?: string;
          created_at?: string;
          description: string;
          diagnostics?: Json;
          id?: string;
          platform?: string | null;
          reporter_email?: string | null;
          reporter_id?: string | null;
          route_name?: string | null;
          screenshot_url?: string | null;
          staff_note?: string | null;
          status?: string;
          subject: string;
          updated_at?: string;
        };
        Update: {
          app_version?: string | null;
          category?: string;
          created_at?: string;
          description?: string;
          diagnostics?: Json;
          id?: string;
          platform?: string | null;
          reporter_email?: string | null;
          reporter_id?: string | null;
          route_name?: string | null;
          screenshot_url?: string | null;
          staff_note?: string | null;
          status?: string;
          subject?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      catalog_provider_state: {
        Row: {
          consecutive_failures: number;
          disabled_reason: string | null;
          last_attempt_at: string | null;
          last_failure_at: string | null;
          last_success_at: string | null;
          provider_id: string;
          rate_limited_until: string | null;
          total_items_written: number;
          total_requests: number;
          updated_at: string;
        };
        Insert: {
          consecutive_failures?: number;
          disabled_reason?: string | null;
          last_attempt_at?: string | null;
          last_failure_at?: string | null;
          last_success_at?: string | null;
          provider_id: string;
          rate_limited_until?: string | null;
          total_items_written?: number;
          total_requests?: number;
          updated_at?: string;
        };
        Update: {
          consecutive_failures?: number;
          disabled_reason?: string | null;
          last_attempt_at?: string | null;
          last_failure_at?: string | null;
          last_success_at?: string | null;
          provider_id?: string;
          rate_limited_until?: string | null;
          total_items_written?: number;
          total_requests?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      catalog_rank_snapshots: {
        Row: {
          computed_at: string;
          lifecycle: Database['public']['Enums']['catalog_lifecycle'];
          rank: number;
          score: number;
          title_id: string;
          window_end: string;
          window_start: string;
          world: string;
        };
        Insert: {
          computed_at?: string;
          lifecycle: Database['public']['Enums']['catalog_lifecycle'];
          rank: number;
          score: number;
          title_id: string;
          window_end: string;
          window_start: string;
          world: string;
        };
        Update: {
          computed_at?: string;
          lifecycle?: Database['public']['Enums']['catalog_lifecycle'];
          rank?: number;
          score?: number;
          title_id?: string;
          window_end?: string;
          window_start?: string;
          world?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'catalog_rank_snapshots_title_id_fkey';
            columns: ['title_id'];
            isOneToOne: false;
            referencedRelation: 'titles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'catalog_rank_snapshots_world_fkey';
            columns: ['world'];
            isOneToOne: false;
            referencedRelation: 'worlds';
            referencedColumns: ['id'];
          },
        ];
      };
      catalog_sync_runs: {
        Row: {
          error: string | null;
          finished_at: string | null;
          id: string;
          idempotency_key: string;
          items_missing: number;
          items_seen: number;
          items_unchanged: number;
          items_written: number;
          job: string;
          provider_id: string;
          provider_requests: number;
          started_at: string;
          status: string;
        };
        Insert: {
          error?: string | null;
          finished_at?: string | null;
          id?: string;
          idempotency_key: string;
          items_missing?: number;
          items_seen?: number;
          items_unchanged?: number;
          items_written?: number;
          job: string;
          provider_id: string;
          provider_requests?: number;
          started_at?: string;
          status?: string;
        };
        Update: {
          error?: string | null;
          finished_at?: string | null;
          id?: string;
          idempotency_key?: string;
          items_missing?: number;
          items_seen?: number;
          items_unchanged?: number;
          items_written?: number;
          job?: string;
          provider_id?: string;
          provider_requests?: number;
          started_at?: string;
          status?: string;
        };
        Relationships: [];
      };
      job_runs: {
        Row: {
          attempt: number;
          duration_ms: number | null;
          error: string | null;
          finished_at: string | null;
          id: string;
          items_processed: number;
          job: string;
          run_key: string;
          started_at: string;
          status: string;
        };
        Insert: {
          attempt?: number;
          duration_ms?: number | null;
          error?: string | null;
          finished_at?: string | null;
          id?: string;
          items_processed?: number;
          job: string;
          run_key: string;
          started_at?: string;
          status?: string;
        };
        Update: {
          attempt?: number;
          duration_ms?: number | null;
          error?: string | null;
          finished_at?: string | null;
          id?: string;
          items_processed?: number;
          job?: string;
          run_key?: string;
          started_at?: string;
          status?: string;
        };
        Relationships: [];
      };
      media_removal_queue: {
        Row: {
          attempts: number;
          created_at: string;
          last_error: string | null;
          path: string;
          reason: Database['public']['Enums']['media_removal_reason'];
          requested_by: string | null;
        };
        Insert: {
          attempts?: number;
          created_at?: string;
          last_error?: string | null;
          path: string;
          reason: Database['public']['Enums']['media_removal_reason'];
          requested_by?: string | null;
        };
        Update: {
          attempts?: number;
          created_at?: string;
          last_error?: string | null;
          path?: string;
          reason?: Database['public']['Enums']['media_removal_reason'];
          requested_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'media_removal_queue_requested_by_fkey';
            columns: ['requested_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      media_uploads: {
        Row: {
          byte_size: number | null;
          content_type: string | null;
          created_at: string;
          duration_ms: number | null;
          error: string | null;
          expires_at: string;
          height: number | null;
          id: string;
          kind: string;
          poster_path: string | null;
          post_id: string | null;
          post_media_id: string | null;
          state: Database['public']['Enums']['media_state'];
          storage_path: string;
          updated_at: string;
          user_id: string;
          width: number | null;
        };
        Insert: {
          byte_size?: number | null;
          content_type?: string | null;
          created_at?: string;
          duration_ms?: number | null;
          error?: string | null;
          expires_at?: string;
          height?: number | null;
          id?: string;
          kind?: string;
          poster_path?: string | null;
          post_id?: string | null;
          post_media_id?: string | null;
          state?: Database['public']['Enums']['media_state'];
          storage_path: string;
          updated_at?: string;
          user_id: string;
          width?: number | null;
        };
        Update: {
          byte_size?: number | null;
          content_type?: string | null;
          created_at?: string;
          duration_ms?: number | null;
          error?: string | null;
          expires_at?: string;
          height?: number | null;
          id?: string;
          kind?: string;
          poster_path?: string | null;
          post_id?: string | null;
          post_media_id?: string | null;
          state?: Database['public']['Enums']['media_state'];
          storage_path?: string;
          updated_at?: string;
          user_id?: string;
          width?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: 'media_uploads_post_id_fkey';
            columns: ['post_id'];
            isOneToOne: false;
            referencedRelation: 'posts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'media_uploads_post_media_id_fkey';
            columns: ['post_media_id'];
            isOneToOne: true;
            referencedRelation: 'post_media';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'media_uploads_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      moderation_actions: {
        Row: {
          action: Database['public']['Enums']['moderation_action_kind'];
          actor_handle: string | null;
          actor_id: string | null;
          created_at: string;
          detail: Json;
          id: string;
          reason: string | null;
          report_id: string | null;
          reverses_id: string | null;
          target_id: string;
          target_type: Database['public']['Enums']['moderation_target'];
        };
        Insert: {
          action: Database['public']['Enums']['moderation_action_kind'];
          actor_handle?: string | null;
          actor_id?: string | null;
          created_at?: string;
          detail?: Json;
          id?: string;
          reason?: string | null;
          report_id?: string | null;
          reverses_id?: string | null;
          target_id: string;
          target_type: Database['public']['Enums']['moderation_target'];
        };
        Update: {
          action?: Database['public']['Enums']['moderation_action_kind'];
          actor_handle?: string | null;
          actor_id?: string | null;
          created_at?: string;
          detail?: Json;
          id?: string;
          reason?: string | null;
          report_id?: string | null;
          reverses_id?: string | null;
          target_id?: string;
          target_type?: Database['public']['Enums']['moderation_target'];
        };
        Relationships: [
          {
            foreignKeyName: 'moderation_actions_actor_id_fkey';
            columns: ['actor_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'moderation_actions_report_id_fkey';
            columns: ['report_id'];
            isOneToOne: false;
            referencedRelation: 'reports';
            referencedColumns: ['id'];
          },
        ];
      };
      notification_deliveries: {
        Row: {
          attempt: number;
          created_at: string;
          id: string;
          last_error: string | null;
          next_attempt_at: string;
          notification_id: string;
          provider: string | null;
          provider_message_id: string | null;
          push_token_id: string;
          sent_at: string | null;
          status: Database['public']['Enums']['delivery_status'];
          updated_at: string;
        };
        Insert: {
          attempt?: number;
          created_at?: string;
          id?: string;
          last_error?: string | null;
          next_attempt_at?: string;
          notification_id: string;
          provider?: string | null;
          provider_message_id?: string | null;
          push_token_id: string;
          sent_at?: string | null;
          status?: Database['public']['Enums']['delivery_status'];
          updated_at?: string;
        };
        Update: {
          attempt?: number;
          created_at?: string;
          id?: string;
          last_error?: string | null;
          next_attempt_at?: string;
          notification_id?: string;
          provider?: string | null;
          provider_message_id?: string | null;
          push_token_id?: string;
          sent_at?: string | null;
          status?: Database['public']['Enums']['delivery_status'];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'notification_deliveries_notification_id_fkey';
            columns: ['notification_id'];
            isOneToOne: false;
            referencedRelation: 'notifications';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'notification_deliveries_push_token_id_fkey';
            columns: ['push_token_id'];
            isOneToOne: false;
            referencedRelation: 'push_tokens';
            referencedColumns: ['id'];
          },
        ];
      };
      post_shares: {
        Row: {
          channel: Database['public']['Enums']['share_channel'];
          created_at: string;
          id: string;
          post_id: string;
          share_date: string;
          user_id: string;
        };
        Insert: {
          channel?: Database['public']['Enums']['share_channel'];
          created_at?: string;
          id?: string;
          post_id: string;
          share_date?: string;
          user_id: string;
        };
        Update: {
          channel?: Database['public']['Enums']['share_channel'];
          created_at?: string;
          id?: string;
          post_id?: string;
          share_date?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'post_shares_post_id_fkey';
            columns: ['post_id'];
            isOneToOne: false;
            referencedRelation: 'posts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'post_shares_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      analytics_events: {
        Row: {
          anonymous_id: string | null;
          app_version: string | null;
          id: number;
          name: string;
          occurred_at: string;
          platform: string | null;
          properties: Json;
          received_at: string;
          session_id: string | null;
          user_id: string | null;
        };
        Insert: {
          anonymous_id?: string | null;
          app_version?: string | null;
          id?: never;
          name: string;
          occurred_at?: string;
          platform?: string | null;
          properties?: Json;
          received_at?: string;
          session_id?: string | null;
          user_id?: string | null;
        };
        Update: {
          anonymous_id?: string | null;
          app_version?: string | null;
          id?: never;
          name?: string;
          occurred_at?: string;
          platform?: string | null;
          properties?: Json;
          received_at?: string;
          session_id?: string | null;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'analytics_events_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      blocks: {
        Row: { blocked_id: string; blocker_id: string; created_at: string };
        Insert: { blocked_id: string; blocker_id: string; created_at?: string };
        Update: { blocked_id?: string; blocker_id?: string; created_at?: string };
        Relationships: [
          {
            foreignKeyName: 'blocks_blocked_id_fkey';
            columns: ['blocked_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'blocks_blocker_id_fkey';
            columns: ['blocker_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      collection_follows: {
        Row: { collection_id: string; created_at: string; user_id: string };
        Insert: { collection_id: string; created_at?: string; user_id: string };
        Update: { collection_id?: string; created_at?: string; user_id?: string };
        Relationships: [
          {
            foreignKeyName: 'collection_follows_collection_id_fkey';
            columns: ['collection_id'];
            isOneToOne: false;
            referencedRelation: 'collections';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'collection_follows_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      collection_items: {
        Row: {
          added_at: string;
          collection_id: string;
          note: string | null;
          position: number;
          title_id: string;
        };
        Insert: {
          added_at?: string;
          collection_id: string;
          note?: string | null;
          position?: number;
          title_id: string;
        };
        Update: {
          added_at?: string;
          collection_id?: string;
          note?: string | null;
          position?: number;
          title_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'collection_items_collection_id_fkey';
            columns: ['collection_id'];
            isOneToOne: false;
            referencedRelation: 'collections';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'collection_items_title_id_fkey';
            columns: ['title_id'];
            isOneToOne: false;
            referencedRelation: 'titles';
            referencedColumns: ['id'];
          },
        ];
      };
      collections: {
        Row: {
          created_at: string;
          description: string | null;
          follower_count: number;
          id: string;
          item_count: number;
          owner_id: string;
          title: string;
          updated_at: string;
          visibility: Database['public']['Enums']['visibility'];
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          follower_count?: number;
          id?: string;
          item_count?: number;
          owner_id: string;
          title: string;
          updated_at?: string;
          visibility?: Database['public']['Enums']['visibility'];
        };
        Update: {
          created_at?: string;
          description?: string | null;
          follower_count?: number;
          id?: string;
          item_count?: number;
          owner_id?: string;
          title?: string;
          updated_at?: string;
          visibility?: Database['public']['Enums']['visibility'];
        };
        Relationships: [
          {
            foreignKeyName: 'collections_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      comments: {
        Row: {
          author_id: string;
          body: string;
          created_at: string;
          cried_count: number;
          deleted_at: string | null;
          edited_at: string | null;
          furious_count: number;
          hidden_at: string | null;
          id: string;
          laughed_count: number;
          loved_count: number;
          parent_id: string | null;
          post_id: string;
          reply_to_user_id: string | null;
          screamed_count: number;
          spoiler: Database['public']['Enums']['spoiler_level'];
          state: Database['public']['Enums']['content_state'];
          swooned_count: number;
          updated_at: string;
        };
        Insert: {
          author_id: string;
          body: string;
          created_at?: string;
          cried_count?: number;
          deleted_at?: string | null;
          edited_at?: string | null;
          furious_count?: number;
          hidden_at?: string | null;
          id?: string;
          laughed_count?: number;
          loved_count?: number;
          parent_id?: string | null;
          post_id: string;
          reply_to_user_id?: string | null;
          screamed_count?: number;
          spoiler?: Database['public']['Enums']['spoiler_level'];
          state?: Database['public']['Enums']['content_state'];
          swooned_count?: number;
          updated_at?: string;
        };
        Update: {
          author_id?: string;
          body?: string;
          created_at?: string;
          cried_count?: number;
          deleted_at?: string | null;
          edited_at?: string | null;
          furious_count?: number;
          hidden_at?: string | null;
          id?: string;
          laughed_count?: number;
          loved_count?: number;
          parent_id?: string | null;
          post_id?: string;
          reply_to_user_id?: string | null;
          screamed_count?: number;
          spoiler?: Database['public']['Enums']['spoiler_level'];
          state?: Database['public']['Enums']['content_state'];
          swooned_count?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'comments_author_id_fkey';
            columns: ['author_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'comments_parent_id_fkey';
            columns: ['parent_id'];
            isOneToOne: false;
            referencedRelation: 'comments';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'comments_post_id_fkey';
            columns: ['post_id'];
            isOneToOne: false;
            referencedRelation: 'posts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'comments_reply_to_user_id_fkey';
            columns: ['reply_to_user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      communities: {
        Row: {
          cover_tone: string;
          cover_url: string | null;
          created_at: string;
          description: string;
          drama_id: string | null;
          fandom: string;
          id: string;
          is_locked: boolean;
          is_official: boolean;
          join_policy: string;
          member_count: number;
          name: string;
          owner_id: string | null;
          post_count: number;
          updated_at: string;
        };
        Insert: {
          cover_tone?: string;
          cover_url?: string | null;
          created_at?: string;
          description?: string;
          drama_id?: string | null;
          fandom: string;
          id?: string;
          is_locked?: boolean;
          is_official?: boolean;
          join_policy?: string;
          member_count?: number;
          name: string;
          owner_id?: string | null;
          post_count?: number;
          updated_at?: string;
        };
        Update: {
          cover_tone?: string;
          cover_url?: string | null;
          created_at?: string;
          description?: string;
          drama_id?: string | null;
          fandom?: string;
          id?: string;
          is_locked?: boolean;
          is_official?: boolean;
          join_policy?: string;
          member_count?: number;
          name?: string;
          owner_id?: string | null;
          post_count?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'communities_drama_id_fkey';
            columns: ['drama_id'];
            isOneToOne: false;
            referencedRelation: 'titles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'communities_fandom_fkey';
            columns: ['fandom'];
            isOneToOne: false;
            referencedRelation: 'worlds';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'communities_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      community_members: {
        Row: {
          community_id: string;
          created_at: string;
          decided_at: string | null;
          decided_by: string | null;
          note: string | null;
          role: string;
          status: Database['public']['Enums']['membership_status'];
          user_id: string;
        };
        Insert: {
          community_id: string;
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          note?: string | null;
          role?: string;
          status?: Database['public']['Enums']['membership_status'];
          user_id: string;
        };
        Update: {
          community_id?: string;
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          note?: string | null;
          role?: string;
          status?: Database['public']['Enums']['membership_status'];
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'community_members_community_id_fkey';
            columns: ['community_id'];
            isOneToOne: false;
            referencedRelation: 'communities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'community_members_decided_by_fkey';
            columns: ['decided_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'community_members_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      follows: {
        Row: { created_at: string; follower_id: string; target_id: string };
        Insert: { created_at?: string; follower_id: string; target_id: string };
        Update: { created_at?: string; follower_id?: string; target_id?: string };
        Relationships: [
          {
            foreignKeyName: 'follows_follower_id_fkey';
            columns: ['follower_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'follows_target_id_fkey';
            columns: ['target_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      mutes: {
        Row: {
          created_at: string;
          muted_title_id: string | null;
          muted_user_id: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          muted_title_id?: string | null;
          muted_user_id?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          muted_title_id?: string | null;
          muted_user_id?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'mutes_muted_title_id_fkey';
            columns: ['muted_title_id'];
            isOneToOne: false;
            referencedRelation: 'titles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'mutes_muted_user_id_fkey';
            columns: ['muted_user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'mutes_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      notifications: {
        Row: {
          actor_ids: string[];
          body: string | null;
          coalesce_count: number;
          collection_id: string | null;
          comment_id: string | null;
          community_id: string | null;
          created_at: string;
          dedupe_key: string | null;
          deep_link: string | null;
          episode: number | null;
          expires_at: string | null;
          id: string;
          kind: Database['public']['Enums']['notification_kind'];
          post_id: string | null;
          read_at: string | null;
          recipient_id: string;
          scheduled_for: string;
          title: string | null;
          title_id: string | null;
          group: Database['public']['Enums']['notification_group'];
        };
        Insert: {
          actor_ids?: string[];
          body?: string | null;
          coalesce_count?: number;
          collection_id?: string | null;
          comment_id?: string | null;
          community_id?: string | null;
          created_at?: string;
          dedupe_key?: string | null;
          deep_link?: string | null;
          episode?: number | null;
          expires_at?: string | null;
          id?: string;
          kind: Database['public']['Enums']['notification_kind'];
          post_id?: string | null;
          read_at?: string | null;
          recipient_id: string;
          scheduled_for?: string;
          title?: string | null;
          title_id?: string | null;
          group?: Database['public']['Enums']['notification_group'];
        };
        Update: {
          actor_ids?: string[];
          body?: string | null;
          coalesce_count?: number;
          collection_id?: string | null;
          comment_id?: string | null;
          community_id?: string | null;
          created_at?: string;
          dedupe_key?: string | null;
          deep_link?: string | null;
          episode?: number | null;
          expires_at?: string | null;
          id?: string;
          kind?: Database['public']['Enums']['notification_kind'];
          post_id?: string | null;
          read_at?: string | null;
          recipient_id?: string;
          scheduled_for?: string;
          title?: string | null;
          title_id?: string | null;
          group?: Database['public']['Enums']['notification_group'];
        };
        Relationships: [
          {
            foreignKeyName: 'notifications_collection_id_fkey';
            columns: ['collection_id'];
            isOneToOne: false;
            referencedRelation: 'collections';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'notifications_comment_id_fkey';
            columns: ['comment_id'];
            isOneToOne: false;
            referencedRelation: 'comments';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'notifications_community_id_fkey';
            columns: ['community_id'];
            isOneToOne: false;
            referencedRelation: 'communities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'notifications_post_id_fkey';
            columns: ['post_id'];
            isOneToOne: false;
            referencedRelation: 'posts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'notifications_recipient_id_fkey';
            columns: ['recipient_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'notifications_title_id_fkey';
            columns: ['title_id'];
            isOneToOne: false;
            referencedRelation: 'titles';
            referencedColumns: ['id'];
          },
        ];
      };
      people: {
        Row: {
          bio: string | null;
          birth_date: string | null;
          catalog_synced_at: string | null;
          content_hash: string | null;
          created_at: string;
          external_id: string;
          follower_count: number;
          id: string;
          known_for_count: number;
          korean_name: string | null;
          name: string;
          photo_url: string | null;
          popularity: number | null;
          provider_id: string;
          updated_at: string;
        };
        Insert: {
          bio?: string | null;
          birth_date?: string | null;
          catalog_synced_at?: string | null;
          content_hash?: string | null;
          created_at?: string;
          external_id: string;
          follower_count?: number;
          id?: string;
          known_for_count?: number;
          korean_name?: string | null;
          name: string;
          photo_url?: string | null;
          popularity?: number | null;
          provider_id: string;
          updated_at?: string;
        };
        Update: {
          bio?: string | null;
          birth_date?: string | null;
          catalog_synced_at?: string | null;
          content_hash?: string | null;
          created_at?: string;
          external_id?: string;
          follower_count?: number;
          id?: string;
          known_for_count?: number;
          korean_name?: string | null;
          name?: string;
          photo_url?: string | null;
          popularity?: number | null;
          provider_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'people_provider_id_fkey';
            columns: ['provider_id'];
            isOneToOne: false;
            referencedRelation: 'providers';
            referencedColumns: ['id'];
          },
        ];
      };
      person_follows: {
        Row: { created_at: string; person_id: string; user_id: string };
        Insert: { created_at?: string; person_id: string; user_id: string };
        Update: { created_at?: string; person_id?: string; user_id?: string };
        Relationships: [
          {
            foreignKeyName: 'person_follows_person_id_fkey';
            columns: ['person_id'];
            isOneToOne: false;
            referencedRelation: 'people';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'person_follows_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      follow_requests: {
        Row: {
          created_at: string;
          decided_at: string | null;
          id: string;
          requester_id: string;
          status: string;
          target_id: string;
        };
        Insert: {
          created_at?: string;
          decided_at?: string | null;
          id?: string;
          requester_id: string;
          status?: string;
          target_id: string;
        };
        Update: {
          created_at?: string;
          decided_at?: string | null;
          id?: string;
          requester_id?: string;
          status?: string;
          target_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'follow_requests_requester_id_fkey';
            columns: ['requester_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'follow_requests_target_id_fkey';
            columns: ['target_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      post_media: {
        Row: {
          created_at: string;
          duration_ms: number | null;
          height: number | null;
          id: string;
          kind: string;
          post_id: string;
          poster_path: string | null;
          position: number;
          storage_path: string;
          width: number | null;
        };
        Insert: {
          created_at?: string;
          duration_ms?: number | null;
          height?: number | null;
          id?: string;
          kind: string;
          post_id: string;
          poster_path?: string | null;
          position?: number;
          storage_path: string;
          width?: number | null;
        };
        Update: {
          created_at?: string;
          duration_ms?: number | null;
          height?: number | null;
          id?: string;
          kind?: string;
          post_id?: string;
          poster_path?: string | null;
          position?: number;
          storage_path?: string;
          width?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: 'post_media_post_id_fkey';
            columns: ['post_id'];
            isOneToOne: false;
            referencedRelation: 'posts';
            referencedColumns: ['id'];
          },
        ];
      };
      posts: {
        Row: {
          author_id: string;
          body: string;
          comment_count: number;
          community_id: string | null;
          created_at: string;
          cried_count: number;
          deleted_at: string | null;
          edited_at: string | null;
          episode: number | null;
          furious_count: number;
          hashtags: string[];
          hidden_at: string | null;
          id: string;
          kind: Database['public']['Enums']['discussion_kind'] | null;
          laughed_count: number;
          loved_count: number;
          mentions: string[];
          rating: number | null;
          save_count: number;
          screamed_count: number;
          search_document: unknown;
          season: number | null;
          secondary_title_id: string | null;
          share_count: number;
          spoiler: Database['public']['Enums']['spoiler_level'];
          state: Database['public']['Enums']['content_state'];
          swooned_count: number;
          title: string | null;
          title_id: string | null;
          type: Database['public']['Enums']['post_type'];
          updated_at: string;
          verdict: string | null;
          visibility: Database['public']['Enums']['visibility'];
          world: string | null;
        };
        Insert: {
          author_id: string;
          body: string;
          comment_count?: number;
          community_id?: string | null;
          created_at?: string;
          cried_count?: number;
          deleted_at?: string | null;
          edited_at?: string | null;
          episode?: number | null;
          furious_count?: number;
          hashtags?: string[];
          hidden_at?: string | null;
          id?: string;
          kind?: Database['public']['Enums']['discussion_kind'] | null;
          laughed_count?: number;
          loved_count?: number;
          mentions?: string[];
          rating?: number | null;
          save_count?: number;
          screamed_count?: number;
          search_document?: never;
          season?: number | null;
          secondary_title_id?: string | null;
          share_count?: number;
          spoiler?: Database['public']['Enums']['spoiler_level'];
          state?: Database['public']['Enums']['content_state'];
          swooned_count?: number;
          title?: string | null;
          title_id?: string | null;
          type?: Database['public']['Enums']['post_type'];
          updated_at?: string;
          verdict?: string | null;
          visibility?: Database['public']['Enums']['visibility'];
          world?: string | null;
        };
        Update: {
          author_id?: string;
          body?: string;
          comment_count?: number;
          community_id?: string | null;
          created_at?: string;
          cried_count?: number;
          deleted_at?: string | null;
          edited_at?: string | null;
          episode?: number | null;
          furious_count?: number;
          hashtags?: string[];
          hidden_at?: string | null;
          id?: string;
          kind?: Database['public']['Enums']['discussion_kind'] | null;
          laughed_count?: number;
          loved_count?: number;
          mentions?: string[];
          rating?: number | null;
          save_count?: number;
          screamed_count?: number;
          search_document?: never;
          season?: number | null;
          secondary_title_id?: string | null;
          share_count?: number;
          spoiler?: Database['public']['Enums']['spoiler_level'];
          state?: Database['public']['Enums']['content_state'];
          swooned_count?: number;
          title?: string | null;
          title_id?: string | null;
          type?: Database['public']['Enums']['post_type'];
          updated_at?: string;
          verdict?: string | null;
          visibility?: Database['public']['Enums']['visibility'];
          world?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'posts_author_id_fkey';
            columns: ['author_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'posts_community_id_fkey';
            columns: ['community_id'];
            isOneToOne: false;
            referencedRelation: 'communities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'posts_secondary_title_id_fkey';
            columns: ['secondary_title_id'];
            isOneToOne: false;
            referencedRelation: 'titles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'posts_title_id_fkey';
            columns: ['title_id'];
            isOneToOne: false;
            referencedRelation: 'titles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'posts_world_fkey';
            columns: ['world'];
            isOneToOne: false;
            referencedRelation: 'worlds';
            referencedColumns: ['id'];
          },
        ];
      };
      direct_messages: {
        Row: {
          body: string;
          created_at: string;
          id: string;
          read_at: string | null;
          recipient_id: string;
          sender_id: string;
          shared_drama_id: string | null;
          shared_post_id: string | null;
        };
        Insert: {
          body: string;
          created_at?: string;
          id?: string;
          read_at?: string | null;
          recipient_id: string;
          sender_id: string;
          shared_drama_id?: string | null;
          shared_post_id?: string | null;
        };
        Update: {
          body?: string;
          created_at?: string;
          id?: string;
          read_at?: string | null;
          recipient_id?: string;
          sender_id?: string;
          shared_drama_id?: string | null;
          shared_post_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'direct_messages_sender_id_fkey';
            columns: ['sender_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'direct_messages_recipient_id_fkey';
            columns: ['recipient_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'direct_messages_shared_post_id_fkey';
            columns: ['shared_post_id'];
            isOneToOne: false;
            referencedRelation: 'posts';
            referencedColumns: ['id'];
          },
        ];
      };
      post_poll_votes: {
        Row: {
          created_at: string;
          option_index: number;
          post_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          option_index: number;
          post_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          option_index?: number;
          post_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'post_poll_votes_post_id_fkey';
            columns: ['post_id'];
            isOneToOne: false;
            referencedRelation: 'post_polls';
            referencedColumns: ['post_id'];
          },
          {
            foreignKeyName: 'post_poll_votes_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      post_polls: {
        Row: {
          closes_at: string | null;
          created_at: string;
          options: string[];
          post_id: string;
          question: string;
        };
        Insert: {
          closes_at?: string | null;
          created_at?: string;
          options: string[];
          post_id: string;
          question: string;
        };
        Update: {
          closes_at?: string | null;
          created_at?: string;
          options?: string[];
          post_id?: string;
          question?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'post_polls_post_id_fkey';
            columns: ['post_id'];
            isOneToOne: true;
            referencedRelation: 'posts';
            referencedColumns: ['id'];
          },
        ];
      };
      profiles: {
        Row: {
          account_status: Database['public']['Enums']['account_status'];
          avatar_path: string | null;
          banner_url: string | null;
          bio: string | null;
          comment_count: number;
          created_at: string;
          deleted_at: string | null;
          display_name: string;
          favorite_genres: string[];
          favorite_title_ids: string[];
          follower_count: number;
          following_count: number;
          handle: string;
          id: string;
          is_private: boolean;
          onboarding_completed: boolean;
          onboarding_genres: string[];
          onboarding_intent: string | null;
          onboarding_step: number;
          post_count: number;
          role: Database['public']['Enums']['profile_role'];
          updated_at: string;
          verified: boolean;
          worlds: string[];
        };
        Insert: {
          account_status?: Database['public']['Enums']['account_status'];
          avatar_path?: string | null;
          banner_url?: string | null;
          bio?: string | null;
          comment_count?: number;
          created_at?: string;
          deleted_at?: string | null;
          display_name: string;
          favorite_genres?: string[];
          favorite_title_ids?: string[];
          follower_count?: number;
          following_count?: number;
          handle: string;
          id: string;
          is_private?: boolean;
          onboarding_completed?: boolean;
          onboarding_genres?: string[];
          onboarding_intent?: string | null;
          onboarding_step?: number;
          post_count?: number;
          role?: Database['public']['Enums']['profile_role'];
          updated_at?: string;
          verified?: boolean;
          worlds?: string[];
        };
        Update: {
          account_status?: Database['public']['Enums']['account_status'];
          avatar_path?: string | null;
          banner_url?: string | null;
          bio?: string | null;
          comment_count?: number;
          created_at?: string;
          deleted_at?: string | null;
          display_name?: string;
          favorite_genres?: string[];
          favorite_title_ids?: string[];
          follower_count?: number;
          following_count?: number;
          handle?: string;
          id?: string;
          is_private?: boolean;
          onboarding_completed?: boolean;
          onboarding_genres?: string[];
          onboarding_intent?: string | null;
          onboarding_step?: number;
          post_count?: number;
          role?: Database['public']['Enums']['profile_role'];
          updated_at?: string;
          verified?: boolean;
          worlds?: string[];
        };
        Relationships: [];
      };
      providers: {
        Row: {
          base_url: string | null;
          created_at: string;
          id: string;
          is_active: boolean;
          label: string;
        };
        Insert: {
          base_url?: string | null;
          created_at?: string;
          id: string;
          is_active?: boolean;
          label: string;
        };
        Update: {
          base_url?: string | null;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          label?: string;
        };
        Relationships: [];
      };
      push_tokens: {
        Row: {
          app_version: string | null;
          created_at: string;
          device_name: string | null;
          disabled_at: string | null;
          id: string;
          last_seen_at: string;
          locale: string | null;
          platform: Database['public']['Enums']['push_platform'];
          token: string;
          user_id: string;
        };
        Insert: {
          app_version?: string | null;
          created_at?: string;
          device_name?: string | null;
          disabled_at?: string | null;
          id?: string;
          last_seen_at?: string;
          locale?: string | null;
          platform: Database['public']['Enums']['push_platform'];
          token: string;
          user_id: string;
        };
        Update: {
          app_version?: string | null;
          created_at?: string;
          device_name?: string | null;
          disabled_at?: string | null;
          id?: string;
          last_seen_at?: string;
          locale?: string | null;
          platform?: Database['public']['Enums']['push_platform'];
          token?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'push_tokens_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      reactions: {
        Row: {
          comment_id: string | null;
          created_at: string;
          id: string;
          kind: Database['public']['Enums']['reaction_kind'];
          post_id: string | null;
          user_id: string;
        };
        Insert: {
          comment_id?: string | null;
          created_at?: string;
          id?: string;
          kind?: Database['public']['Enums']['reaction_kind'];
          post_id?: string | null;
          user_id: string;
        };
        Update: {
          comment_id?: string | null;
          created_at?: string;
          id?: string;
          kind?: Database['public']['Enums']['reaction_kind'];
          post_id?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'reactions_comment_id_fkey';
            columns: ['comment_id'];
            isOneToOne: false;
            referencedRelation: 'comments';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'reactions_post_id_fkey';
            columns: ['post_id'];
            isOneToOne: false;
            referencedRelation: 'posts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'reactions_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      reports: {
        Row: {
          created_at: string;
          detail: string | null;
          id: string;
          reason: string;
          reporter_id: string;
          resolution: string | null;
          resolved_at: string | null;
          resolved_by: string | null;
          status: Database['public']['Enums']['report_status'];
          target_id: string;
          target_type: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          detail?: string | null;
          id?: string;
          reason: string;
          reporter_id: string;
          resolution?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          status?: Database['public']['Enums']['report_status'];
          target_id: string;
          target_type: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          detail?: string | null;
          id?: string;
          reason?: string;
          reporter_id?: string;
          resolution?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          status?: Database['public']['Enums']['report_status'];
          target_id?: string;
          target_type?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'reports_reporter_id_fkey';
            columns: ['reporter_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'reports_resolved_by_fkey';
            columns: ['resolved_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      saves: {
        Row: { created_at: string; post_id: string; user_id: string };
        Insert: { created_at?: string; post_id: string; user_id: string };
        Update: { created_at?: string; post_id?: string; user_id?: string };
        Relationships: [
          {
            foreignKeyName: 'saves_post_id_fkey';
            columns: ['post_id'];
            isOneToOne: false;
            referencedRelation: 'posts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'saves_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      title_alerts: {
        Row: { created_at: string; title_id: string; user_id: string };
        Insert: { created_at?: string; title_id: string; user_id: string };
        Update: { created_at?: string; title_id?: string; user_id?: string };
        Relationships: [
          {
            foreignKeyName: 'title_alerts_title_id_fkey';
            columns: ['title_id'];
            isOneToOne: false;
            referencedRelation: 'titles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'title_alerts_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      title_episodes: {
        Row: {
          air_date: string | null;
          air_time: string | null;
          catalog_synced_at: string | null;
          created_at: string;
          episode_type: number;
          number: number;
          runtime_minutes: number | null;
          season: number;
          still_url: string | null;
          synopsis: string | null;
          title: string | null;
          title_id: string;
          updated_at: string;
        };
        Insert: {
          air_date?: string | null;
          air_time?: string | null;
          catalog_synced_at?: string | null;
          created_at?: string;
          episode_type?: number;
          number: number;
          runtime_minutes?: number | null;
          season: number;
          still_url?: string | null;
          synopsis?: string | null;
          title?: string | null;
          title_id: string;
          updated_at?: string;
        };
        Update: {
          air_date?: string | null;
          air_time?: string | null;
          catalog_synced_at?: string | null;
          created_at?: string;
          episode_type?: number;
          number?: number;
          runtime_minutes?: number | null;
          season?: number;
          still_url?: string | null;
          synopsis?: string | null;
          title?: string | null;
          title_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'title_episodes_title_id_fkey';
            columns: ['title_id'];
            isOneToOne: false;
            referencedRelation: 'titles';
            referencedColumns: ['id'];
          },
        ];
      };
      title_follows: {
        Row: { created_at: string; title_id: string; user_id: string };
        Insert: { created_at?: string; title_id: string; user_id: string };
        Update: { created_at?: string; title_id?: string; user_id?: string };
        Relationships: [
          {
            foreignKeyName: 'title_follows_title_id_fkey';
            columns: ['title_id'];
            isOneToOne: false;
            referencedRelation: 'titles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'title_follows_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      title_people: {
        Row: {
          catalog_synced_at: string | null;
          character: string | null;
          job: string;
          order_index: number;
          person_id: string;
          title_id: string;
        };
        Insert: {
          catalog_synced_at?: string | null;
          character?: string | null;
          job?: string;
          order_index?: number;
          person_id: string;
          title_id: string;
        };
        Update: {
          catalog_synced_at?: string | null;
          character?: string | null;
          job?: string;
          order_index?: number;
          person_id?: string;
          title_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'title_people_person_id_fkey';
            columns: ['person_id'];
            isOneToOne: false;
            referencedRelation: 'people';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'title_people_title_id_fkey';
            columns: ['title_id'];
            isOneToOne: false;
            referencedRelation: 'titles';
            referencedColumns: ['id'];
          },
        ];
      };
      titles: {
        Row: {
          airs_on: string | null;
          backdrop_url: string | null;
          catalog_missing_count: number;
          catalog_synced_at: string | null;
          catalog_unavailable_at: string | null;
          community_rating: number | null;
          content_hash: string | null;
          created_at: string;
          end_year: number | null;
          episode_count: number;
          external_id: string;
          first_air_date: string | null;
          follower_count: number;
          genres: string[];
          id: string;
          last_air_date: string | null;
          media_type: Database['public']['Enums']['media_type'];
          network: string | null;
          next_episode_at: string | null;
          origin_country: string[];
          original_language: string | null;
          original_title: string | null;
          popularity: number | null;
          poster_url: string | null;
          provider_data: Json;
          provider_id: string;
          runtime_minutes: number | null;
          search_document: unknown;
          season_count: number;
          status: Database['public']['Enums']['title_status'];
          streaming_on: string[];
          synopsis: string | null;
          tags: string[];
          title: string;
          tone: string | null;
          trailer_url: string | null;
          updated_at: string;
          vote_average: number | null;
          vote_count: number;
          world: string;
          year: number;
        };
        Insert: {
          airs_on?: string | null;
          backdrop_url?: string | null;
          catalog_missing_count?: number;
          catalog_synced_at?: string | null;
          catalog_unavailable_at?: string | null;
          community_rating?: number | null;
          content_hash?: string | null;
          created_at?: string;
          end_year?: number | null;
          episode_count?: number;
          external_id: string;
          first_air_date?: string | null;
          follower_count?: number;
          genres?: string[];
          id?: string;
          last_air_date?: string | null;
          media_type: Database['public']['Enums']['media_type'];
          network?: string | null;
          next_episode_at?: string | null;
          origin_country?: string[];
          original_language?: string | null;
          original_title?: string | null;
          popularity?: number | null;
          poster_url?: string | null;
          provider_data?: Json;
          provider_id: string;
          runtime_minutes?: number | null;
          search_document?: never;
          season_count?: number;
          status?: Database['public']['Enums']['title_status'];
          streaming_on?: string[];
          synopsis?: string | null;
          tags?: string[];
          title: string;
          tone?: string | null;
          trailer_url?: string | null;
          updated_at?: string;
          vote_average?: number | null;
          vote_count?: number;
          world: string;
          year: number;
        };
        Update: {
          airs_on?: string | null;
          backdrop_url?: string | null;
          catalog_missing_count?: number;
          catalog_synced_at?: string | null;
          catalog_unavailable_at?: string | null;
          community_rating?: number | null;
          content_hash?: string | null;
          created_at?: string;
          end_year?: number | null;
          episode_count?: number;
          external_id?: string;
          first_air_date?: string | null;
          follower_count?: number;
          genres?: string[];
          id?: string;
          last_air_date?: string | null;
          media_type?: Database['public']['Enums']['media_type'];
          network?: string | null;
          next_episode_at?: string | null;
          origin_country?: string[];
          original_language?: string | null;
          original_title?: string | null;
          popularity?: number | null;
          poster_url?: string | null;
          provider_data?: Json;
          provider_id?: string;
          runtime_minutes?: number | null;
          search_document?: never;
          season_count?: number;
          status?: Database['public']['Enums']['title_status'];
          streaming_on?: string[];
          synopsis?: string | null;
          tags?: string[];
          title?: string;
          tone?: string | null;
          trailer_url?: string | null;
          updated_at?: string;
          vote_average?: number | null;
          vote_count?: number;
          world?: string;
          year?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'titles_provider_id_fkey';
            columns: ['provider_id'];
            isOneToOne: false;
            referencedRelation: 'providers';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'titles_world_fkey';
            columns: ['world'];
            isOneToOne: false;
            referencedRelation: 'worlds';
            referencedColumns: ['id'];
          },
        ];
      };
      user_preferences: {
        Row: {
          autoplay: Database['public']['Enums']['autoplay_mode'];
          created_at: string;
          data_saver: boolean;
          guidelines_accepted: boolean;
          guidelines_accepted_at: string | null;
          language: string;
          muted_words: string[];
          notify_episodes: boolean;
          notify_highlights: boolean;
          notify_social: boolean;
          notify_system: boolean;
          one_tap_reactions: boolean;
          personalization: boolean;
          protection: Database['public']['Enums']['protection_level'];
          quiet_hours: boolean;
          reduce_motion: boolean;
          terms_version: number;
          true_black: boolean;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          autoplay?: Database['public']['Enums']['autoplay_mode'];
          created_at?: string;
          data_saver?: boolean;
          guidelines_accepted?: boolean;
          guidelines_accepted_at?: string | null;
          language?: string;
          muted_words?: string[];
          notify_episodes?: boolean;
          notify_highlights?: boolean;
          notify_social?: boolean;
          notify_system?: boolean;
          one_tap_reactions?: boolean;
          personalization?: boolean;
          protection?: Database['public']['Enums']['protection_level'];
          quiet_hours?: boolean;
          reduce_motion?: boolean;
          terms_version?: number;
          true_black?: boolean;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          autoplay?: Database['public']['Enums']['autoplay_mode'];
          created_at?: string;
          data_saver?: boolean;
          guidelines_accepted?: boolean;
          guidelines_accepted_at?: string | null;
          language?: string;
          muted_words?: string[];
          notify_episodes?: boolean;
          notify_highlights?: boolean;
          notify_social?: boolean;
          notify_system?: boolean;
          one_tap_reactions?: boolean;
          personalization?: boolean;
          protection?: Database['public']['Enums']['protection_level'];
          quiet_hours?: boolean;
          reduce_motion?: boolean;
          terms_version?: number;
          true_black?: boolean;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'user_preferences_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: true;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      title_ratings: {
        Row: {
          created_at: string;
          score: number;
          title_id: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          score: number;
          title_id: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          score?: number;
          title_id?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'title_ratings_title_id_fkey';
            columns: ['title_id'];
            isOneToOne: false;
            referencedRelation: 'titles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'title_ratings_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      video_access_requests: {
        Row: {
          created_at: string;
          decided_at: string | null;
          decided_by: string | null;
          decision_note: string | null;
          id: string;
          note: string | null;
          status: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          decision_note?: string | null;
          id?: string;
          note?: string | null;
          status?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          decision_note?: string | null;
          id?: string;
          note?: string | null;
          status?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'video_access_requests_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'video_access_requests_decided_by_fkey';
            columns: ['decided_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      video_creators: {
        Row: {
          created_at: string;
          granted_at: string;
          granted_by: string | null;
          monthly_byte_budget: number;
          note: string | null;
          revoke_reason: string | null;
          revoked_at: string | null;
          revoked_by: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          granted_at?: string;
          granted_by?: string | null;
          monthly_byte_budget?: number;
          note?: string | null;
          revoke_reason?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          granted_at?: string;
          granted_by?: string | null;
          monthly_byte_budget?: number;
          note?: string | null;
          revoke_reason?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'video_creators_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: true;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'video_creators_granted_by_fkey';
            columns: ['granted_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'video_creators_revoked_by_fkey';
            columns: ['revoked_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      watchlist_items: {
        Row: {
          added_at: string;
          completed_at: string | null;
          current_episode: number;
          note: string | null;
          season: number;
          status: Database['public']['Enums']['watch_status'];
          title_id: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          added_at?: string;
          completed_at?: string | null;
          current_episode?: number;
          note?: string | null;
          season?: number;
          status?: Database['public']['Enums']['watch_status'];
          title_id: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          added_at?: string;
          completed_at?: string | null;
          current_episode?: number;
          note?: string | null;
          season?: number;
          status?: Database['public']['Enums']['watch_status'];
          title_id?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'watchlist_items_title_id_fkey';
            columns: ['title_id'];
            isOneToOne: false;
            referencedRelation: 'titles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'watchlist_items_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      worlds: {
        Row: {
          created_at: string;
          flag: string;
          id: string;
          label: string;
          short_label: string;
          sort_order: number;
          tint: string;
        };
        Insert: {
          created_at?: string;
          flag: string;
          id: string;
          label: string;
          short_label: string;
          sort_order?: number;
          tint: string;
        };
        Update: {
          created_at?: string;
          flag?: string;
          id?: string;
          label?: string;
          short_label?: string;
          sort_order?: number;
          tint?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: {
      airing_titles: {
        Args: { p_limit?: number; p_offset?: number; p_world?: string };
        Returns: Json[];
      };
      ban_community_member: {
        Args: { p_community_id: string; p_reason?: string; p_user_id: string };
        Returns: Database['public']['Enums']['membership_status'];
      };
      begin_media_upload: {
        Args: { p_byte_size?: number; p_content_type?: string; p_kind?: string; p_storage_path: string };
        Returns: string;
      };
      can_administer_community: {
        Args: { p_community_id: string };
        Returns: boolean;
      };
      catalog_begin_run: {
        Args: { p_idempotency_key?: string; p_job: string; p_provider_id?: string };
        Returns: string;
      };
      catalog_finish_run: {
        Args: {
          p_error?: string;
          p_items_missing?: number;
          p_items_seen?: number;
          p_items_unchanged?: number;
          p_items_written?: number;
          p_run_id: string;
          p_status: string;
        };
        Returns: undefined;
      };
      catalog_lifecycle_of: {
        Args: { p_title: Database['public']['Tables']['titles']['Row'] };
        Returns: Database['public']['Enums']['catalog_lifecycle'];
      };
      catalog_mark_missing: {
        Args: { p_external_ids: string[]; p_media_type: Database['public']['Enums']['media_type']; p_provider_id: string };
        Returns: number;
      };
      catalog_provider_health: {
        Args: Record<never, never>;
        Returns: Json;
      };
      catalog_provider_is_usable: {
        Args: { p_provider_id: string };
        Returns: boolean;
      };
      catalog_recompute_next_episode: {
        Args: { p_title_id: string };
        Returns: string | null;
      };
      catalog_recompute_title_state: {
        Args: { p_title_id: string };
        Returns: Database['public']['Enums']['title_status'] | null;
      };
      catalog_refresh_interval: {
        Args: { p_status: Database['public']['Enums']['title_status'] };
        Returns: string;
      };
      catalog_relevance_score: {
        Args: {
          p_lifecycle?: Database['public']['Enums']['catalog_lifecycle'] | null;
          p_title: Database['public']['Tables']['titles']['Row'];
          p_world?: string | null;
        };
        Returns: number;
      };
      catalog_upsert_episodes: {
        Args: { p_episodes: Json; p_season: number; p_title_id: string };
        Returns: number;
      };
      catalog_upsert_person: {
        Args: { p_payload: Json; p_provider_id: string };
        Returns: string;
      };
      catalog_upsert_title: {
        Args: { p_payload: Json; p_provider_id: string };
        Returns: { id: string; written: boolean }[];
      };
      catalog_upsert_title_people: {
        Args: { p_credits: Json; p_title_id: string };
        Returns: number;
      };
      claim_community_ownership: {
        Args: { p_community_id: string };
        Returns: boolean;
      };
      claim_notification_deliveries: {
        Args: { p_limit?: number; p_max_attempts?: number };
        Returns: Json[];
      };
      comment_page: {
        Args: { p_cursor?: string; p_limit?: number; p_post_id: string };
        Returns: Json;
      };
      community_roster: {
        Args: { p_community_id: string; p_limit?: number };
        Returns: Json;
      };
      complete_media_upload: {
        Args: {
          p_duration_ms?: number;
          p_height?: number;
          p_poster_path?: string;
          p_position?: number;
          p_post_id?: string;
          p_upload_id: string;
          p_width?: number;
        };
        Returns: string;
      };
      decode_feed_cursor: {
        Args: { p_cursor: string };
        Returns: { created_at: string; id: string; rank_key: number }[];
      };
      disable_all_push_tokens: {
        Args: Record<never, never>;
        Returns: number;
      };
      disable_push_token: {
        Args: { p_token_id: string };
        Returns: boolean;
      };
      encode_feed_cursor: {
        Args: { p_created_at: string; p_id: string; p_rank_key: number };
        Returns: string;
      };
      enqueue_notification: {
        Args: {
          p_actor_ids?: string[];
          p_body?: string;
          p_collection_id?: string;
          p_comment_id?: string;
          p_community_id?: string;
          p_dedupe_key: string;
          p_deep_link?: string;
          p_episode?: number;
          p_expires_at?: string;
          p_group: Database['public']['Enums']['notification_group'];
          p_kind: Database['public']['Enums']['notification_kind'];
          p_post_id?: string;
          p_recipient: string;
          p_scheduled_for?: string;
          p_title?: string;
          p_title_id?: string;
        };
        Returns: string | null;
      };
      escalate_report: {
        Args: { p_note: string; p_report_id: string; p_to_role?: string };
        Returns: boolean;
      };
      fail_media_upload: {
        Args: { p_error?: string; p_upload_id: string };
        Returns: boolean;
      };
      fanout_due_notifications: {
        Args: { p_limit?: number };
        Returns: number;
      };
      fanout_notification: {
        Args: { p_notification_id: string };
        Returns: number;
      };
      feed_page: {
        Args: {
          p_community_id?: string;
          p_cursor?: string;
          p_limit?: number;
          p_scope?: string;
          p_title_id?: string;
          p_world?: string;
        };
        Returns: Json;
      };
      get_home_discovery: {
        Args: { p_limit?: number; p_worlds?: string[] };
        Returns: Json;
      };
      get_title_discovery: {
        Args: { p_title_id: string };
        Returns: Json;
      };
      get_world_discoveries: {
        Args: { p_limit?: number };
        Returns: Json;
      };
      is_admin: {
        Args: Record<never, never>;
        Returns: boolean;
      };
      job_claim: {
        Args: { p_job: string; p_run_key: string };
        Returns: { attempt: number; did_claim: boolean; id: string }[];
      };
      job_complete: {
        Args: { p_error?: string; p_items_processed?: number; p_run_id: string; p_status: string };
        Returns: undefined;
      };
      job_expire_notifications: {
        Args: { p_retention?: string };
        Returns: { deliveries_removed: number; notifications_removed: number; read_removed: number }[];
      };
      job_prune_stale_catalog: {
        Args: Record<never, never>;
        Returns: { titles_available: number; titles_parked: number }[];
      };
      job_queue_new_episodes: {
        Args: { p_from_date?: string; p_to_date?: string };
        Returns: number;
      };
      job_queue_title_updates: {
        Args: { p_limit?: number };
        Returns: number;
      };
      job_queue_upcoming_episodes: {
        Args: { p_from_date?: string; p_limit?: number; p_to_date?: string };
        Returns: number;
      };
      job_recompute_community_post_counts: {
        Args: Record<never, never>;
        Returns: number;
      };
      job_reconcile_catalog_status: {
        Args: { p_limit?: number };
        Returns: number;
      };
      job_reconcile_episode_schedule: {
        Args: { p_limit?: number };
        Returns: number;
      };
      job_reconcile_media: {
        Args: { p_user_retention?: string };
        Returns: Json;
      };
      job_reconcile_moderation: {
        Args: Record<never, never>;
        Returns: Json;
      };
      job_refresh_trending: {
        Args: { p_world?: string };
        Returns: number;
      };
      job_release_stale: {
        Args: { p_older_than?: string };
        Returns: number;
      };
      join_community: {
        Args: { p_community_id: string; p_on?: boolean };
        Returns: Json;
      };
      media_drop_missing_objects: {
        Args: Record<never, never>;
        Returns: number;
      };
      media_remove_orphans: {
        Args: { p_older_than?: string; p_user_older_than?: string };
        Returns: { objects_queued: number; uploads_purged: number }[];
      };
      claim_media_removals: {
        Args: { p_limit?: number };
        Returns: { attempts: number; path: string; reason: Database['public']['Enums']['media_removal_reason'] }[];
      };
      complete_media_removals: {
        Args: { p_error?: string | null; p_paths: string[] };
        Returns: number;
      };
      queue_media_removal: {
        Args: {
          p_paths: string[];
          p_reason: Database['public']['Enums']['media_removal_reason'];
          p_requested_by?: string | null;
        };
        Returns: number;
      };
      moderate_community_post: {
        Args: { p_action: string; p_post_id: string; p_reason?: string };
        Returns: Database['public']['Enums']['content_state'];
      };
      moderate_content: {
        Args: {
          p_action: string;
          p_reason?: string;
          p_report_id?: string;
          p_target_id: string;
          p_target_type: string;
        };
        Returns: Database['public']['Enums']['content_state'];
      };
      moderation_history: {
        Args: { p_limit?: number; p_target_id: string; p_target_type: Database['public']['Enums']['moderation_target'] };
        Returns: Database['public']['Tables']['moderation_actions']['Row'][];
      };
      moderation_queue: {
        Args: { p_limit?: number; p_offset?: number; p_status?: Database['public']['Enums']['report_status'] };
        Returns: Json;
      };
      notify_at_for: {
        Args: { p_moment: string; p_user_id: string };
        Returns: string;
      };
      notification_summary: {
        Args: Record<never, never>;
        Returns: Json;
      };
      record_delivery: {
        Args: {
          p_delivery_id: string;
          p_error?: string;
          p_invalid?: boolean;
          p_provider_message_id?: string;
          p_sent: boolean;
        };
        Returns: undefined;
      };
      record_moderation_action: {
        Args: {
          p_action: Database['public']['Enums']['moderation_action_kind'];
          p_detail?: Json;
          p_reason?: string;
          p_report_id?: string;
          p_reverses_id?: string;
          p_target_id: string;
          p_target_type: Database['public']['Enums']['moderation_target'];
        };
        Returns: string;
      };
      record_share: {
        Args: { p_channel?: Database['public']['Enums']['share_channel']; p_post_id: string };
        Returns: Json;
      };
      recently_released_titles: {
        Args: { p_limit?: number; p_offset?: number; p_world?: string };
        Returns: Json[];
      };
      recommended_titles: {
        Args: { p_limit?: number; p_offset?: number };
        Returns: Json[];
      };
      refresh_trending: {
        Args: { p_window?: string; p_world?: string };
        Returns: number;
      };
      remove_community_member: {
        Args: { p_community_id: string; p_reason?: string; p_user_id: string };
        Returns: boolean;
      };
      report_delivery: {
        Args: {
          p_delivery_id: string;
          p_error?: string;
          p_invalid?: boolean;
          p_provider_message_id?: string;
          p_sent: boolean;
        };
        Returns: undefined;
      };
      require_community_admin: {
        Args: { p_community_id: string };
        Returns: undefined;
      };
      require_moderator: {
        Args: { p_action?: string };
        Returns: string;
      };
      resolve_report: {
        Args: {
          p_content_action?: string;
          p_outcome: string;
          p_report_id: string;
          p_resolution: string;
        };
        Returns: Json;
      };
      review_membership_request: {
        Args: { p_approve: boolean; p_community_id: string; p_note?: string; p_user_id: string };
        Returns: Database['public']['Enums']['membership_status'];
      };
      run_scheduled_jobs: {
        Args: { p_jobs?: string[] };
        Returns: { error: string; items: number; job: string; run_id: string; status: string }[];
      };
      search_all: {
        Args: { p_per_type?: number; p_query: string; p_world?: string };
        Returns: Json;
      };
      search_collections: {
        Args: { p_limit?: number; p_offset?: number; p_query: string };
        Returns: Json[];
      };
      search_communities: {
        Args: { p_limit?: number; p_offset?: number; p_query: string; p_world?: string };
        Returns: Json[];
      };
      search_members: {
        Args: { p_limit?: number; p_offset?: number; p_query: string };
        Returns: Json[];
      };
      search_people: {
        Args: { p_limit?: number; p_offset?: number; p_query: string };
        Returns: Json[];
      };
      search_suggestions: {
        Args: { p_limit?: number; p_query: string };
        Returns: { id: string; kind: string; label: string; subtitle: string }[];
      };
      set_community_role: {
        Args: { p_community_id: string; p_role: string; p_user_id: string };
        Returns: string;
      };
      suspend_user: {
        Args: { p_days?: number; p_reason: string; p_user_id: string };
        Returns: Json;
      };
      title_audience: {
        Args: { p_title_id: string };
        Returns: string[];
      };
      title_search_rank: {
        Args: {
          p_lifecycle?: Database['public']['Enums']['catalog_lifecycle'] | null;
          p_original_title: string;
          p_query: string;
          p_search_document: unknown;
          p_title: string;
        };
        Returns: number;
      };
      titles_needing_refresh: {
        Args: { p_limit?: number; p_world?: string };
        Returns: {
          external_id: string;
          media_type: Database['public']['Enums']['media_type'];
          priority: number;
          provider_id: string;
          reason: string;
          status: Database['public']['Enums']['title_status'];
          title_id: string;
        }[];
      };
      browse_titles: {
        Args: {
          p_genre?: string;
          p_limit?: number;
          p_offset?: number;
          p_provider?: string;
          p_sort?: string;
          p_world?: string;
        };
        Returns: Database['public']['Tables']['titles']['Row'][];
      };
      catalog_is_valid_world: {
        Args: {
          p_genres: string[];
          p_media_type: string;
          p_origin_country: string[];
          p_original_language: string;
          p_world: string;
        };
        Returns: boolean;
      };
      send_test_notification: {
        Args: Record<string, never>;
        Returns: Json;
      };
      top_rated_titles: {
        Args: {
          p_limit?: number;
          p_world?: string;
        };
        Returns: Database['public']['Tables']['titles']['Row'][];
      };
      world_leaders: {
        Args: Record<string, never>;
        Returns: {
          backdrop_url: string | null;
          episode_count: number;
          first_air_date: string | null;
          follower_count: number;
          genres: string[];
          id: string;
          lifecycle: Database['public']['Enums']['catalog_lifecycle'];
          media_type: Database['public']['Enums']['media_type'];
          network: string | null;
          next_episode_at: string | null;
          original_title: string | null;
          poster_url: string | null;
          score: number;
          season_count: number;
          status: Database['public']['Enums']['title_status'];
          synopsis: string | null;
          title: string;
          vote_average: number | null;
          world: string;
          year: number;
        }[];
      };
      trending_titles: {
        Args: {
          p_genre?: string;
          p_lifecycle?: Database['public']['Enums']['catalog_lifecycle'][];
          p_limit?: number;
          p_offset?: number;
          p_world?: string;
        };
        Returns: Json[];
      };
      transfer_community_ownership: {
        Args: { p_community_id: string; p_new_owner_id: string };
        Returns: boolean;
      };
      upcoming_titles: {
        Args: { p_days?: number; p_limit?: number; p_offset?: number; p_world?: string };
        Returns: Json[];
      };
      unsuspend_user: {
        Args: { p_reason?: string; p_user_id: string };
        Returns: boolean;
      };
      update_community_settings: {
        Args: {
          p_community_id: string;
          p_cover_tone?: string;
          p_cover_url?: string;
          p_description?: string;
          p_join_policy?: string;
          p_locked?: boolean;
          p_name?: string;
        };
        Returns: Database['public']['Tables']['communities']['Row'];
      };
      complete_onboarding: {
        Args: { p_genres?: string[]; p_step?: number; p_worlds?: string[] };
        Returns: Database['public']['Tables']['profiles']['Row'];
      };
      delete_account: {
        Args: Record<never, never>;
        Returns: Json;
      };
      feed_posts: {
        Args: {
          p_limit?: number;
          p_offset?: number;
          p_scope?: string;
          p_title_id?: string;
          p_world?: string;
        };
        Returns: Database['public']['Tables']['posts']['Row'][];
      };
      get_bootstrap: {
        Args: Record<never, never>;
        Returns: Json;
      };
      create_community_room: {
        Args: {
          p_cover_tone?: string;
          p_description?: string;
          p_fandom: string;
          p_name: string;
        };
        Returns: Json;
      };
      get_community_detail: {
        Args: { p_community_id: string };
        Returns: Json;
      };
      get_staff_overview: {
        Args: Record<never, never>;
        Returns: Json;
      };
      list_follow_requests: {
        Args: Record<never, never>;
        Returns: Json;
      };
      my_video_access_status: {
        Args: Record<never, never>;
        Returns: Json;
      };
      respond_follow_request: {
        Args: { p_accept: boolean; p_requester_id: string };
        Returns: Json;
      };
      staff_grant_video_by_handle: {
        Args: { p_budget_mb?: number; p_handle: string; p_note?: string };
        Returns: Json;
      };
      get_community_pulse: {
        Args: { p_limit?: number; p_world?: string };
        Returns: Json;
      };
      get_feed_bundle: {
        Args: {
          p_community_id?: string;
          p_cursor?: string;
          p_limit?: number;
          p_scope?: string;
          p_title_id?: string;
          p_world?: string;
        };
        Returns: Json;
      };
      get_person_detail: {
        Args: { p_person_id: string };
        Returns: Json;
      };
      get_post_thread: {
        Args: { p_comment_limit?: number; p_post_id: string };
        Returns: Json;
      };
      get_profile_by_handle: {
        Args: { p_handle: string };
        Returns: Json;
      };
      get_public_collections: {
        Args: { p_limit?: number };
        Returns: Json;
      };
      grant_video_access: {
        Args: { p_monthly_byte_budget?: number; p_note?: string; p_user: string };
        Returns: Database['public']['Tables']['video_creators']['Row'];
      };
      handle_is_available: {
        Args: { p_handle: string };
        Returns: boolean;
      };
      is_moderator: {
        Args: Record<never, never>;
        Returns: boolean;
      };
      mark_notifications_read: {
        Args: { p_group?: Database['public']['Enums']['notification_group']; p_ids?: string[] };
        Returns: number;
      };
      merge_preferences: {
        Args: { p_patch: Json };
        Returns: Database['public']['Tables']['user_preferences']['Row'];
      };
      purge_deleted_accounts: {
        Args: { retention?: string };
        Returns: { profiles_purged: number; storage_objects_queued: number }[];
      };
      record_event: {
        Args: {
          p_anonymous_id?: string;
          p_app_version?: string;
          p_name: string;
          p_platform?: string;
          p_properties?: Json;
          p_session_id?: string;
        };
        Returns: number;
      };
      register_push_token: {
        Args: {
          p_app_version?: string;
          p_device_name?: string;
          p_locale?: string;
          p_platform: Database['public']['Enums']['push_platform'];
          p_token: string;
        };
        Returns: string;
      };
      report_content: {
        Args: { p_detail?: string; p_reason: string; p_target_id: string; p_target_type: string };
        Returns: string;
      };
      request_video_access: {
        Args: { p_note?: string };
        Returns: string;
      };
      review_video_access_request: {
        Args: { p_approve: boolean; p_monthly_byte_budget?: number; p_note?: string; p_request_id: string };
        Returns: Database['public']['Tables']['video_access_requests']['Row'];
      };
      revoke_video_access: {
        Args: { p_reason?: string; p_user: string };
        Returns: Database['public']['Tables']['video_creators']['Row'];
      };
      search_titles: {
        Args: { p_limit?: number; p_offset?: number; p_query: string; p_world?: string };
        Returns: Database['public']['Tables']['titles']['Row'][];
      };
      set_block: {
        Args: { p_on: boolean; p_user_id: string };
        Returns: boolean;
      };
      set_follow: {
        Args: { p_kind: string; p_on: boolean; p_target_id: string };
        Returns: boolean;
      };
      set_mute: {
        Args: { p_kind: string; p_on: boolean; p_target_id: string };
        Returns: boolean;
      };
      set_title_alert: {
        Args: { p_on?: boolean; p_title_id: string };
        Returns: boolean;
      };
      storage_owner: {
        Args: { name: string };
        Returns: string | null;
      };
      toggle_favorite_title: {
        Args: { p_on?: boolean; p_title_id: string };
        Returns: Json;
      };
      toggle_reaction: {
        Args: { p_kind: Database['public']['Enums']['reaction_kind']; p_target_id: string; p_target_type: string };
        Returns: Json;
      };
      toggle_save: {
        Args: { p_post_id: string };
        Returns: boolean;
      };
      upsert_watchlist_item: {
        Args: {
          p_episode?: number;
          p_note?: string;
          p_season?: number;
          p_status?: Database['public']['Enums']['watch_status'];
          p_title_id: string;
          p_total?: number;
        };
        Returns: Database['public']['Tables']['watchlist_items']['Row'];
      };
      create_post_poll: {
        Args: {
          p_hours?: number;
          p_options: string[];
          p_post_id: string;
          p_question: string;
        };
        Returns: Json;
      };
      discover_catalog: {
        Args: {
          p_genre?: string | null;
          p_limit?: number;
          p_min_rating?: number | null;
          p_min_year?: number | null;
          p_offset?: number;
          p_provider?: string | null;
          p_sort?: string;
          p_status?: string | null;
          p_world?: string | null;
        };
        Returns: Database['public']['Tables']['titles']['Row'][];
      };
      get_post_polls: {
        Args: { p_post_ids: string[] };
        Returns: Json;
      };
      list_conversations: {
        Args: { p_limit?: number };
        Returns: Json;
      };
      announce_app_release: {
        Args: {
          p_release_notes?: string | null;
          p_version_code: number;
          p_version_name: string;
        };
        Returns: Json;
      };
      list_direct_messages: {
        Args: { p_limit?: number; p_peer_handle: string };
        Returns: Json;
      };
      mark_conversation_read: {
        Args: { p_peer_handle: string };
        Returns: number;
      };
      rate_title: {
        Args: { p_score: number; p_title_id: string };
        Returns: Json;
      };
      send_direct_message: {
        Args: {
          p_body: string;
          p_recipient_handle: string;
          p_shared_drama_id?: string | null;
          p_shared_post_id?: string | null;
        };
        Returns: Json;
      };
      video_access: {
        Args: { p_user?: string };
        Returns: boolean;
      };
      video_bytes_used_this_month: {
        Args: { p_user?: string };
        Returns: number;
      };
      video_creator_roster: {
        Args: { p_limit?: number };
        Returns: Json;
      };
      video_quota: {
        Args: { p_user?: string };
        Returns: Json;
      };
      vote_post_poll: {
        Args: { p_option_index: number; p_post_id: string };
        Returns: Json;
      };
    };
    Enums: {
      account_status: 'active' | 'suspended' | 'deleted';
      autoplay_mode: 'always' | 'wifi' | 'never';
      catalog_lifecycle: 'airing' | 'upcoming' | 'recent' | 'classic' | 'unavailable';
      content_state: 'active' | 'deleted' | 'hidden';
      delivery_status: 'queued' | 'sending' | 'sent' | 'failed' | 'invalid_token' | 'skipped';
      discussion_kind: 'general' | 'theory' | 'ending' | 'character' | 'scene' | 'question';
      media_state: 'pending' | 'attached' | 'failed' | 'orphaned';
      media_removal_reason:
        | 'failed_upload'
        | 'orphaned'
        | 'stale_catalog'
        | 'account_deleted'
        | 'retention_purge';
      media_type: 'tv' | 'movie';
      membership_status: 'active' | 'pending' | 'banned';
      moderation_action_kind:
        | 'report_resolved'
        | 'report_dismissed'
        | 'report_escalated'
        | 'content_hidden'
        | 'content_restored'
        | 'content_removed'
        | 'user_suspended'
        | 'user_unsuspended'
        | 'room_post_hidden'
        | 'room_post_restored';
      moderation_target: 'post' | 'comment' | 'user' | 'collection' | 'community' | 'title' | 'report';
      notification_group: 'social' | 'drama' | 'mentions' | 'system';
      notification_kind:
        | 'reaction'
        | 'comment'
        | 'reply'
        | 'follow'
        | 'mention'
        | 'episode_aired'
        | 'episode_live'
        | 'drama_trending'
        | 'collection_saved'
        | 'system';
      post_type: 'post' | 'reaction' | 'discussion' | 'review' | 'recommendation' | 'short';
      profile_role: 'member' | 'moderator' | 'admin';
      protection_level: 'strict' | 'balanced' | 'off';
      push_platform: 'ios' | 'android' | 'web';
      reaction_kind: 'loved' | 'cried' | 'screamed' | 'swooned' | 'laughed' | 'furious';
      report_status: 'open' | 'reviewing' | 'resolved' | 'dismissed';
      share_channel: 'link' | 'inapp' | 'system';
      spoiler_level: 'none' | 'episode' | 'season' | 'ending';
      title_status: 'upcoming' | 'airing' | 'completed' | 'canceled';
      visibility: 'public' | 'private';
      watch_status: 'want' | 'watching' | 'completed' | 'dropped';
    };
    CompositeTypes: Record<never, never>;
  };
};

/** Convenience aliases, matching what supabase gen types emits. */
export type Tables = Database['public']['Tables'];

export type TablesInsert<T extends keyof Tables> = Tables[T]['Insert'];
export type TablesUpdate<T extends keyof Tables> = Tables[T]['Update'];
export type TablesRow<T extends keyof Tables> = Tables[T]['Row'];
export type Enums<T extends keyof Database['public']['Enums']> = Database['public']['Enums'][T];

export type ProfileRow = TablesRow<'profiles'>;
export type PostRow = TablesRow<'posts'>;
export type CommentRow = TablesRow<'comments'>;
export type ReactionRow = TablesRow<'reactions'>;
export type TitleRow = TablesRow<'titles'>;
export type NotificationRow = TablesRow<'notifications'>;
export type WatchlistRow = TablesRow<'watchlist_items'>;
export type CollectionRow = TablesRow<'collections'>;