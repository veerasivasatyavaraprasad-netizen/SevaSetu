import { useEffect, useState } from 'react';
import { Image, Linking, View } from 'react-native';
import { api } from './api';
import { API_URL } from './config';
import { Badge, Card, T } from './ui';

// Sponsored brand placements (plan §2), always labelled.
export default function Sponsored({ slot, category, pincode }) {
  const [ads, setAds] = useState([]);
  useEffect(() => {
    const qs = new URLSearchParams({ slot, ...(category ? { category } : {}), ...(pincode ? { pincode } : {}) });
    api(`/ads?${qs}`).then((d) => setAds(d.ads)).catch(() => setAds([]));
  }, [slot, category, pincode]);
  return ads.map((a) => (
    <Card key={a.id} onPress={() => Linking.openURL(`${API_URL}${a.clickUrl}`)} style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
      {a.imageUrl && <Image source={{ uri: `${API_URL}${a.imageUrl}` }} style={{ width: 64, height: 64, borderRadius: 10 }} accessibilityIgnoresInvertColors />}
      <View style={{ flex: 1, gap: 2 }}>
        <Badge>Sponsored · {a.brand}</Badge>
        <T bold>{a.title}</T>
        {!!a.body && <T small muted>{a.body}</T>}
      </View>
    </Card>
  ));
}
