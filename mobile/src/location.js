import * as Location from 'expo-location';

// Current position with accuracy and the OS mock-location flag. The API
// suspends workers whose check-in comes from a mock provider (§9.6).
export async function currentPosition() {
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') throw new Error('Please allow location access to continue');
  const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  return {
    lat: loc.coords.latitude,
    lng: loc.coords.longitude,
    accuracyM: Math.round(loc.coords.accuracy ?? 999),
    isMock: loc.mocked === true,
  };
}
