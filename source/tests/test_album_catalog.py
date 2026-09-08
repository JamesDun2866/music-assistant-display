import unittest
from sendspin_karaoke_source.album_catalog import catalog_reference, catalog_url, valid_reference
from sendspin_karaoke_source.album_provider import album_fields


class CatalogReferenceTests(unittest.TestCase):
    def test_canonical_collection_and_track_urls_only(self):
        self.assertEqual(catalog_url("https://music.apple.com/gb/album/the-album/123456?i=98765&app=music"),
                         {"kind": "collection", "id": "123456", "country": "gb"})
        self.assertEqual(catalog_url("https://music.apple.com/us/song/hello/12345"),
                         {"kind": "track", "id": "12345", "country": "us"})
        for url in (
            "http://music.apple.com/gb/album/title/123", "https://music.apple.com.evil/gb/album/title/123",
            "https://music.apple.com:443/gb/album/title/123", "https://u@music.apple.com/gb/album/title/123",
            "https://music.apple.com/gb/artist/title/123", "https://music.apple.com/gb/playlist/title/123",
            "https://music.apple.com/gb/album/title/00123", "https://music.apple.com/gb/album/title/123#x",
            "https://music.apple.com/gb/album/title/123?i=5&i=6", "https://music.apple.com/gb/album/title/123?i=x",
            "https://music.apple.com/us/song/123?i=456", "https://music.apple.com/album/title/123",
            "https://music.apple.com/us/album/title/" + "1" * 16,
        ):
            with self.subTest(url=url):
                self.assertIsNone(catalog_url(url))

    def test_documented_hub_option_action_uri_and_conflicts(self):
        track = {"hub": {"options": [{"actions": [{"uri": "https://music.apple.com/gb/album/title/123?i=45"}]}]},
                 "artists": [{"id": "wrong-album"}], "lyrics": "not exported"}
        expected = {"kind": "collection", "id": "123", "country": "gb"}
        self.assertEqual(catalog_reference(track), expected)
        self.assertTrue(valid_reference(expected))
        track["hub"]["options"][0]["actions"].append({"uri": "https://music.apple.com/gb/album/title/456"})
        self.assertIsNone(catalog_reference(track))
        self.assertIsNone(catalog_reference({"artists": [{"id": "123"}]}))
        self.assertFalse(valid_reference({**expected, "url": "https://evil"}))

    def test_album_stays_available_without_catalog_and_ignores_unrelated_response_data(self):
        track = {"subtitle": "Artist", "sections": [
            {"type": "SONG", "metadata": [{"title": "Album", "text": "Album"}]},
            {"type": "LYRICS", "text": ["discard"]},
        ]}
        self.assertEqual(album_fields({"track": track}),
                         {"title": "Album", "artist": "Artist", "artwork": None, "catalog": None})


if __name__ == "__main__":
    unittest.main()
