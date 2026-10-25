#ifndef PEARTUBE_PLAYER_H
#define PEARTUBE_PLAYER_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* All calls are serialized by the app on the main thread. The UIView remains
 * alive through destroy. No handle may be used after destroy. Returned UTF-8
 * strings belong to the caller and must be freed with peartube_player_string_free.
 * Failed calls return NULL / -1; last_error returns an owned diagnostic string.
 * destroy detaches immediately and retires the blocking Player off-main. */
typedef struct PearTubePlayer PearTubePlayer;
PearTubePlayer *peartube_player_create(void *ui_view);
int32_t peartube_player_open(PearTubePlayer *, const char *url, const char *soundfont_path);
int32_t peartube_player_frame(PearTubePlayer *, double width, double height);
int32_t peartube_player_play(PearTubePlayer *);
int32_t peartube_player_pause(PearTubePlayer *);
int32_t peartube_player_seek(PearTubePlayer *, int64_t position_ms);
int32_t peartube_player_select_audio(PearTubePlayer *, int32_t stream);
int32_t peartube_player_select_subtitle(PearTubePlayer *, int32_t stream);
int32_t peartube_player_suspend(PearTubePlayer *);
int32_t peartube_player_resume(PearTubePlayer *);
char *peartube_player_state(PearTubePlayer *);
char *peartube_player_last_error(void);
void peartube_player_string_free(char *);
void peartube_player_destroy(PearTubePlayer *);
#ifdef __cplusplus
}
#endif
#endif
