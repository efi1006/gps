
let map;
let marker;
let currentPosition = { lat: 32.0853, lng: 34.7818 }; // Default location: Tel Aviv

function initMap() {
    map = new google.maps.Map(document.getElementById('map'), {
        center: currentPosition,
        zoom: 14
    });

    // Create marker for current location
    marker = new google.maps.Marker({
        position: currentPosition,
        map: map,
        title: "Current Location"
    });

    // Check Geolocation API
    if (navigator.geolocation) {
        navigator.geolocation.watchPosition(
            (position) => {
                currentPosition = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude,
                };

                // Update marker position and map center
                marker.setPosition(currentPosition);
                map.setCenter(currentPosition);
            },
            () => {
                console.error("Geolocation failed");
            }
        );
    } else {
        console.error("Geolocation is not supported by this browser.");
    }
}

window.onload = initMap;
